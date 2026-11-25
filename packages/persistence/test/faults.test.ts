import type { JsonValue } from '@swf/core';
import { SwfFailure } from '@swf/core';
import { describe, expect, it } from 'vitest';
import type {
  PersistenceExtension,
  PolicySource,
  RestoreOutcome,
  SchemaMigration,
} from '../src/index.js';
import {
  jsonSyntaxError,
  migrateDocument,
  parseJson,
  SNAPSHOT_SCHEMA_ID,
  snapshotLimits,
} from '../src/index.js';
import { layout, persistenceOf, workspace } from './fixtures.js';

/** The typed failure `fn` throws, or what else happened. */
function thrown(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    if (error instanceof SwfFailure) {
      return error.error;
    }
    throw error;
  }
  throw new Error('it was accepted');
}

function rejectedWith(outcome: RestoreOutcome) {
  if (outcome.status !== 'rejected') {
    throw new Error('it was restored');
  }
  return outcome.error;
}

function restored(outcome: RestoreOutcome) {
  if (outcome.status !== 'restored') {
    throw new Error(`rejected: ${outcome.error.code} ${outcome.error.message}`);
  }
  return outcome;
}

/** A promise that rejects, to see that whoever is handed it handles the rejection. */
function rejecting(reason: string): Promise<never> {
  return Promise.reject(new Error(reason));
}

/** Lets every pending rejection surface, so an unhandled one fails the test that made it. */
async function drain(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 10);
  });
}

const extension = (over: Partial<PersistenceExtension> = {}): PersistenceExtension => ({
  namespace: 'ext.notes',
  version: 1,
  capture: () => ({ items: [] }),
  restore: () => undefined,
  ...over,
});

const policy = (over: Partial<PolicySource> = {}): PolicySource => ({
  id: 'host.snap/1',
  capture: () => ({ distance: 1 }),
  ...over,
});

describe('text nested deeper than any stack (FR-201)', () => {
  it('locates the break in deeply nested text without overflowing', () => {
    const depth = 200_000;
    expect(jsonSyntaxError('['.repeat(depth))).toEqual({
      offset: depth,
      line: 1,
      column: depth + 1,
      expected: 'a value',
    });
    expect(jsonSyntaxError('{"a":'.repeat(depth))).toMatchObject({
      offset: depth * 5,
      expected: 'a value',
    });
    expect(jsonSyntaxError(`${'['.repeat(depth)}1${']'.repeat(depth - 1)}`)).toMatchObject({
      offset: depth * 2,
      expected: 'a comma (,) or the end of the array (])',
    });
    const valid = `${'[{"a":'.repeat(depth)}0${'}]'.repeat(depth)}`;
    expect(jsonSyntaxError(valid)).toBeNull();
    expect(jsonSyntaxError(`${valid} x`)).toMatchObject({
      offset: valid.length + 1,
      expected: 'the end of the text',
    });
  });

  it('refuses such a snapshot with its own rejection, saying where it breaks', async () => {
    const text = '['.repeat(200_000);
    expect(thrown(() => parseJson(text))).toMatchObject({
      code: 'SNAPSHOT_INVALID',
      details: { line: 1, column: 200_001, offset: 200_000 },
    });
    const ws = layout();
    const before = ws.getState();
    expect(rejectedWith(await persistenceOf(ws).restore(text))).toMatchObject({
      code: 'SNAPSHOT_INVALID',
      message: 'the snapshot is not JSON: at line 1, column 200001, a value was expected',
    });
    expect(ws.getState()).toBe(before);
  });
});

describe('a registration whose watch fails (FR-162, FR-160)', () => {
  it('leaves nothing registered, so the owner can register again', async () => {
    const p = persistenceOf(layout());
    expect(
      thrown(() =>
        p.registerExtension(
          extension({
            watch: () => {
              throw new Error('no events here');
            },
          }),
        ),
      ),
    ).toMatchObject({
      code: 'EXTENSION_FAILED',
      path: 'watch',
      message: 'extension "ext.notes" could not start watching its state: no events here',
    });
    expect(
      thrown(() =>
        p.registerPolicy(
          policy({
            watch: () => {
              throw new Error('no events here');
            },
          }),
        ),
      ),
    ).toMatchObject({
      code: 'EXTENSION_FAILED',
      path: 'watch',
      message: 'policy "host.snap/1" could not start watching its parameters: no events here',
    });
    const capture = await p.capture();
    expect(capture.document.extensions).toEqual({});
    expect(capture.document.policies).toEqual({});
    // A retry registers.
    p.registerExtension(extension());
    p.registerPolicy(policy());
    const again = await p.capture();
    expect(Object.keys(again.document.extensions)).toEqual(['ext.notes']);
    expect(Object.keys(again.document.policies)).toEqual(['host.snap/1']);
  });

  it('refuses a watch that gives back no way to stop it, and stops hearing it', () => {
    const p = persistenceOf(layout());
    for (const returned of [undefined, 'stop', Promise.resolve(() => undefined)]) {
      let changed: () => void = () => undefined;
      expect(
        thrown(() =>
          p.registerExtension(
            extension({
              watch: (notify) => {
                changed = notify;
                return returned as never;
              },
            }),
          ),
        ),
      ).toMatchObject({
        code: 'EXTENSION_FAILED',
        path: 'watch',
        message: expect.stringMatching(
          /^extension "ext\.notes" could not start watching its state: watch returned .+, not a function that stops it$/,
        ) as unknown,
      });
      changed();
      expect(p.changes()).toBe(0);
    }
    expect(thrown(() => p.registerPolicy(policy({ watch: () => null as never })))).toMatchObject({
      code: 'EXTENSION_FAILED',
      path: 'watch',
    });
    p.registerExtension(extension({ watch: () => () => undefined }));
    p.registerPolicy(policy({ watch: () => () => undefined }));
  });
});

describe('a policy taking back its parameters (FR-160, FR-163)', () => {
  it('awaits a policy that takes them back asynchronously, and reports its rejection', async () => {
    const text = await savedWith((p) => {
      p.registerPolicy(policy({ id: 'host.depth/1' }));
    });
    const p = persistenceOf(workspace());
    const took: JsonValue[] = [];
    p.registerPolicy(
      policy({
        restore: async (parameters) => {
          await Promise.resolve();
          took.push(parameters);
        },
      }),
    );
    p.registerPolicy(
      policy({ id: 'host.depth/1', restore: () => rejecting('the depth bands are gone') }),
    );
    const outcome = restored(await p.restore(text));
    expect(took).toEqual([{ distance: 1 }]);
    expect(outcome.failures).toEqual([
      {
        kind: 'policy',
        id: 'host.depth/1',
        error: expect.objectContaining({
          code: 'EXTENSION_FAILED',
          path: 'policies.host.depth/1',
          message:
            'policy "host.depth/1" failed to take back its parameters: the depth bands are gone',
        }) as unknown,
      },
    ]);
    await drain();
  });

  it('gives a policy the hook timeout and the caller’s signal, and tells it when it is over', async () => {
    const text = await savedWith();
    const p = persistenceOf(workspace(), { hookTimeoutMs: 20 });
    let signal: AbortSignal | null = null;
    p.registerPolicy(
      policy({
        restore: (_parameters, context) => {
          signal = context.signal;
          return new Promise(() => undefined);
        },
      }),
    );
    const outcome = restored(await p.restore(text));
    expect(outcome.failures).toEqual([
      {
        kind: 'policy',
        id: 'host.snap/1',
        error: expect.objectContaining({
          code: 'EXTENSION_FAILED',
          message: 'policy "host.snap/1" did not take back its parameters within 20 ms',
          details: { reason: 'timeout' },
        }) as unknown,
      },
    ]);
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    // The caller's signal cancels it.
    const controller = new AbortController();
    controller.abort();
    const cancelled = restored(await p.restore(text, { signal: controller.signal }));
    expect(cancelled.failures[0]?.error).toMatchObject({ code: 'CANCELLED' });
  });

  it('refuses a policy capture that answers with a promise, and handles its rejection', async () => {
    const p = persistenceOf(layout());
    p.registerPolicy(policy({ capture: () => rejecting('not yet') }));
    const capture = await p.capture();
    expect(capture.failures).toEqual([
      {
        kind: 'policy',
        id: 'host.snap/1',
        error: expect.objectContaining({
          code: 'INVALID_INPUT',
          path: 'policies.host.snap/1',
          message:
            'policy "host.snap/1" could not be captured: capture returned a promise; it gives its parameters synchronously',
        }) as unknown,
      },
    ]);
    await drain();
  });
});

describe('a migration step that answers with something else (FR-165)', () => {
  const legacy = { schema: 'host.legacy/1' };
  const step = (migrate: SchemaMigration['migrate']): SchemaMigration => ({
    from: 'host.legacy/1',
    to: SNAPSHOT_SCHEMA_ID,
    migrate,
  });

  it('fails the migration, naming the step and what it returned', async () => {
    const cases: [unknown, RegExp, string | undefined][] = [
      [undefined, /returned undefined, not \{ document, warnings \}/, undefined],
      [null, /returned null, not \{ document, warnings \}/, undefined],
      [7, /returned a number, not \{ document, warnings \}/, undefined],
      [rejecting('later'), /returned a promise; a step runs synchronously/, undefined],
      [{ document: legacy, warnings: 'lossy' }, /warnings must be a list of strings/, 'warnings'],
      [
        { document: legacy, warnings: [Symbol('x')] },
        /warnings must be a list of strings/,
        'warnings',
      ],
    ];
    for (const [result, message, path] of cases) {
      const migrations = [step(() => result as never)];
      expect(thrown(() => migrateDocument(legacy, { migrations }))).toMatchObject({
        code: 'MIGRATION_FAILED',
        message: expect.stringMatching(message) as unknown,
        details: { sourceVersion: 'host.legacy/1', from: 'host.legacy/1', to: SNAPSHOT_SCHEMA_ID },
        ...(path === undefined ? {} : { path }),
      });
      const p = persistenceOf(layout(), { migrations });
      expect(rejectedWith(await p.restore(legacy))).toMatchObject({ code: 'MIGRATION_FAILED' });
    }
    await drain();
  });

  it('refuses an extension migration that answers with a promise, and handles its rejection', async () => {
    const text = await savedWith((p) => {
      p.registerExtension(extension());
    });
    const p = persistenceOf(workspace());
    p.registerExtension(extension({ version: 2, migrate: () => rejecting('later') }));
    const outcome = restored(await p.restore(text));
    expect(outcome.failures).toEqual([
      {
        kind: 'extension',
        id: 'ext.notes',
        error: expect.objectContaining({
          code: 'MIGRATION_FAILED',
          path: 'extensions.ext.notes.data',
          message:
            'extension "ext.notes" failed to migrate its state from version 1: migrate returned a promise; it migrates synchronously',
        }) as unknown,
      },
    ]);
    await drain();
  });
});

describe('names every object inherits (DATA-014)', () => {
  it('are not size limits', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      const limits = JSON.parse(`{"${name}": 5}`) as never;
      expect(thrown(() => snapshotLimits(limits))).toMatchObject({
        code: 'INVALID_INPUT',
        path: `limits.${name}`,
        message: `limits.${name} is not a limit`,
      });
    }
  });
});

/** A snapshot of a layout with a policy `host.snap/1` and whatever `register` adds. */
async function savedWith(
  register: (p: ReturnType<typeof persistenceOf>) => void = () => undefined,
): Promise<string> {
  const p = persistenceOf(layout());
  p.registerPolicy(policy());
  register(p);
  return p.export((await p.capture()).document);
}
