import { ChunkBackoff, classifyFailure } from './backoff';

describe('classifyFailure', () => {
  it('sorts ledger and other failures', () => {
    expect(classifyFailure(new Error('Chunk rebuilt from the ledger does not match its content hash'))).toBe('invalid');
    expect(classifyFailure(new Error('Segment 3 is missing from the ledger'))).toBe('incomplete');
    expect(classifyFailure(new Error('No segments found in the ledger'))).toBe('incomplete');
    expect(classifyFailure(new Error('fetch failed'))).toBe('error');
    expect(classifyFailure('weird')).toBe('error');
  });
});

describe('ChunkBackoff', () => {
  const policy = { invalidMs: 1_000_000, baseMs: 100, maxMs: 1_000 };

  it('blocks a chunk until its retry time', () => {
    const backoff = new ChunkBackoff(policy);
    backoff.fail('a', new Error('boom'), 0);
    expect(backoff.isBlocked('a', 99)).toBe(true);
    expect(backoff.isBlocked('a', 100)).toBe(false);
    expect(backoff.isBlocked('b', 0)).toBe(false);
  });

  it('doubles the delay up to the cap; invalid data waits invalidMs', () => {
    const backoff = new ChunkBackoff(policy);
    const delays = [1, 2, 3, 4, 5, 6].map(() => backoff.fail('a', new Error('rpc'), 0).retryAt);
    expect(delays).toEqual([100, 200, 400, 800, 1_000, 1_000]);
    expect(backoff.fail('b', new Error('does not match its content hash'), 5).retryAt).toBe(1_000_005);
  });

  it('forgets cleared chunks and chunks that left the scan', () => {
    const backoff = new ChunkBackoff(policy);
    backoff.fail('a', new Error('x'), 0);
    backoff.fail('b', new Error('Segment 1 is missing'), 0);
    backoff.fail('c', new Error('does not match its content hash'), 0);
    expect(backoff.summary()).toMatchObject({ invalid: 1, incomplete: 1, error: 1 });
    expect(backoff.summary().chunks.map((c) => c.chunk)).toEqual(['a', 'b', 'c']);

    backoff.clear('a');
    backoff.retain(new Set(['c']));
    expect(backoff.size).toBe(1);
    expect(backoff.summary()).toMatchObject({ invalid: 1, incomplete: 0, error: 0 });
  });
});
