import { describe, expect, it } from 'vitest';
import { main as kernel } from '../kernel.ts';
import { main as saveAndRestore } from '../save-and-restore.ts';
import { main as surfaceAdapter } from '../surface-adapter.ts';

/** Each example runs as written and does what it says it does. */
describe('the examples', () => {
  const quiet = () => undefined;

  it('kernel: commits, refuses atomically, groups, replays a retry and undoes', async () => {
    const facts = await kernel(quiet);
    expect(facts.refused).toBe('INVALID_INPUT');
    expect(facts.nodes).toEqual(['chart', 'desk', 'notes']);
    expect(facts.notesParent).toBe('desk');
    expect(facts.replayed).toBe(true);
    expect(facts.worldY).toBeCloseTo(0.5, 12);
    expect(facts.revision).toBe(5);
    expect(facts.events).toContain('transaction.rejected');
  });

  it('save-and-restore: restores the layout with its surface waiting as a placeholder', async () => {
    const facts = await saveAndRestore(quiet);
    expect(facts).toEqual({
      saved: 'saved',
      restored: 'restored',
      surfaceState: 'unbound',
      bindingKey: 'editor-42',
      pinned: ['editor-42'],
      refusal: 'SNAPSHOT_INVALID at line 1, column 41',
    });
  });

  it('surface-adapter: passes every applicable case of the adapter conformance suite', async () => {
    const results = await surfaceAdapter(quiet);
    expect(results.filter((r) => r.outcome === 'failed')).toEqual([]);
    expect(results.filter((r) => r.outcome === 'passed').length).toBeGreaterThanOrEqual(10);
  });
});
