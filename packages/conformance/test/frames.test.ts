import { describe, expect, it } from 'vitest';
import { ManualFrames } from '../src/index.js';

describe('manual frames', () => {
  it('runs every request of a flush when one throws at once, then passes its failure on', async () => {
    const frames = new ManualFrames();
    const ran: string[] = [];
    frames.request(() => {
      ran.push('first');
    });
    frames.request(() => {
      throw new Error('the second throws');
    });
    frames.request(() => {
      ran.push('third');
    });
    await expect(frames.flush()).rejects.toThrow('the second throws');
    expect(ran).toEqual(['first', 'third']);
    expect(frames.pending).toBe(0);
  });

  it('waits for every request of a flush, and reports each failure when more than one fails', async () => {
    const frames = new ManualFrames();
    const ran: string[] = [];
    frames.request(() => Promise.reject(new Error('the first rejects')));
    frames.request(() => {
      throw new Error('the second throws');
    });
    frames.request(async () => {
      await Promise.resolve();
      ran.push('third');
    });
    const error: unknown = await frames.flush().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((e: unknown) => (e as Error).message)).toEqual([
      'the first rejects',
      'the second throws',
    ]);
    expect(ran).toEqual(['third']);
  });

  it('resolves to how many requests ran, not those they request in turn', async () => {
    const frames = new ManualFrames();
    frames.request(() => frames.request(() => undefined));
    frames.request(() => undefined);
    expect(await frames.flush()).toBe(2);
    expect(frames.pending).toBe(1);
  });
});
