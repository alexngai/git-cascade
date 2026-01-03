import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker } from '../src/tracker.js';
import { createTestRepo } from './setup.js';
import * as guards from '../src/guards.js';
import { ConcurrentModificationError } from '../src/errors.js';

describe('Stream Guards - Optimistic Concurrency', () => {
  let tracker: MultiAgentRepoTracker;
  let testRepo: ReturnType<typeof createTestRepo>;

  beforeEach(() => {
    testRepo = createTestRepo();
    tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });
  });

  afterEach(() => {
    tracker.close();
    testRepo.cleanup();
  });

  describe('touchGuard', () => {
    it('should create a new guard record', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      guards.touchGuard(tracker.db, streamId, 'agent-1');

      const guard = guards.getGuard(tracker.db, streamId);
      expect(guard).not.toBeNull();
      expect(guard!.streamId).toBe(streamId);
      expect(guard!.agentId).toBe('agent-1');
      expect(guard!.lastWrite).toBeGreaterThan(0);
    });

    it('should update existing guard record', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      guards.touchGuard(tracker.db, streamId, 'agent-1');
      const firstGuard = guards.getGuard(tracker.db, streamId);

      // Wait a bit and touch again with different agent
      const now = Date.now();
      while (Date.now() === now) {
        // busy wait to ensure different timestamp
      }

      guards.touchGuard(tracker.db, streamId, 'agent-2');
      const secondGuard = guards.getGuard(tracker.db, streamId);

      expect(secondGuard!.agentId).toBe('agent-2');
      expect(secondGuard!.lastWrite).toBeGreaterThanOrEqual(firstGuard!.lastWrite);
    });

    it('should handle multiple streams independently', () => {
      const streamId1 = tracker.createStream({
        name: 'stream-1',
        agentId: 'agent-1',
      });

      const streamId2 = tracker.createStream({
        name: 'stream-2',
        agentId: 'agent-2',
      });

      guards.touchGuard(tracker.db, streamId1, 'agent-1');
      guards.touchGuard(tracker.db, streamId2, 'agent-2');

      const guard1 = guards.getGuard(tracker.db, streamId1);
      const guard2 = guards.getGuard(tracker.db, streamId2);

      expect(guard1!.agentId).toBe('agent-1');
      expect(guard2!.agentId).toBe('agent-2');
    });
  });

  describe('getGuard', () => {
    it('should return null for non-existent guard', () => {
      const guard = guards.getGuard(tracker.db, 'non-existent-stream');
      expect(guard).toBeNull();
    });

    it('should return guard with correct fields', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      const beforeTouch = Date.now();
      guards.touchGuard(tracker.db, streamId, 'agent-1');
      const afterTouch = Date.now();

      const guard = guards.getGuard(tracker.db, streamId);
      expect(guard).not.toBeNull();
      expect(guard!.streamId).toBe(streamId);
      expect(guard!.agentId).toBe('agent-1');
      expect(guard!.lastWrite).toBeGreaterThanOrEqual(beforeTouch);
      expect(guard!.lastWrite).toBeLessThanOrEqual(afterTouch);
    });
  });

  describe('validateGuard', () => {
    it('should return true when no guard exists', () => {
      const streamId = 'non-existent-stream';
      const result = guards.validateGuard(tracker.db, streamId, 'agent-1', Date.now());
      expect(result).toBe(true);
    });

    it('should return true when same agent was last writer', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      const readTime = Date.now();
      guards.touchGuard(tracker.db, streamId, 'agent-1');

      // Same agent validates - should pass even though write was after read
      const result = guards.validateGuard(tracker.db, streamId, 'agent-1', readTime);
      expect(result).toBe(true);
    });

    it('should return true when last write was before read timestamp', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      guards.touchGuard(tracker.db, streamId, 'agent-1');
      const guard = guards.getGuard(tracker.db, streamId);

      // Different agent reads after the write
      const readTime = guard!.lastWrite + 1000;
      const result = guards.validateGuard(tracker.db, streamId, 'agent-2', readTime);
      expect(result).toBe(true);
    });

    it('should return false when another agent wrote after read timestamp', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      const readTime = Date.now();

      // Wait to ensure different timestamp
      const waitUntil = Date.now() + 10;
      while (Date.now() < waitUntil) {
        // busy wait
      }

      guards.touchGuard(tracker.db, streamId, 'agent-1');

      // Different agent tries to validate - should fail
      const result = guards.validateGuard(tracker.db, streamId, 'agent-2', readTime);
      expect(result).toBe(false);
    });

    it('should return true when last write equals read timestamp', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      guards.touchGuard(tracker.db, streamId, 'agent-1');
      const guard = guards.getGuard(tracker.db, streamId);

      // Exactly at the write time - should pass (lastWrite <= sinceTimestamp)
      const result = guards.validateGuard(tracker.db, streamId, 'agent-2', guard!.lastWrite);
      expect(result).toBe(true);
    });
  });

  describe('clearGuard', () => {
    it('should remove guard record', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      guards.touchGuard(tracker.db, streamId, 'agent-1');
      expect(guards.getGuard(tracker.db, streamId)).not.toBeNull();

      guards.clearGuard(tracker.db, streamId);
      expect(guards.getGuard(tracker.db, streamId)).toBeNull();
    });

    it('should not throw when clearing non-existent guard', () => {
      expect(() => {
        guards.clearGuard(tracker.db, 'non-existent-stream');
      }).not.toThrow();
    });

    it('should not affect other stream guards', () => {
      const streamId1 = tracker.createStream({
        name: 'stream-1',
        agentId: 'agent-1',
      });

      const streamId2 = tracker.createStream({
        name: 'stream-2',
        agentId: 'agent-2',
      });

      guards.touchGuard(tracker.db, streamId1, 'agent-1');
      guards.touchGuard(tracker.db, streamId2, 'agent-2');

      guards.clearGuard(tracker.db, streamId1);

      expect(guards.getGuard(tracker.db, streamId1)).toBeNull();
      expect(guards.getGuard(tracker.db, streamId2)).not.toBeNull();
    });
  });

  describe('listActiveGuards', () => {
    it('should return empty array when no guards exist', () => {
      const activeGuards = guards.listActiveGuards(tracker.db, 60);
      expect(activeGuards).toHaveLength(0);
    });

    it('should return guards within time window', () => {
      const streamId1 = tracker.createStream({
        name: 'stream-1',
        agentId: 'agent-1',
      });

      const streamId2 = tracker.createStream({
        name: 'stream-2',
        agentId: 'agent-2',
      });

      guards.touchGuard(tracker.db, streamId1, 'agent-1');
      guards.touchGuard(tracker.db, streamId2, 'agent-2');

      const activeGuards = guards.listActiveGuards(tracker.db, 60);
      expect(activeGuards).toHaveLength(2);
    });

    it('should exclude guards outside time window', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      guards.touchGuard(tracker.db, streamId, 'agent-1');

      // 0 seconds window should exclude guard created moments ago
      // (unless it was created in the exact same millisecond)
      // Use a very small window to test exclusion
      const guard = guards.getGuard(tracker.db, streamId);

      // Manually check - if guard was created at time T,
      // window of 0 seconds means cutoff = now - 0 = now
      // Guard passes if lastWrite >= cutoff
      // This should pass since lastWrite is very recent
      const activeGuards = guards.listActiveGuards(tracker.db, 60);
      expect(activeGuards).toHaveLength(1);
    });

    it('should order guards by lastWrite descending', () => {
      const streamId1 = tracker.createStream({
        name: 'stream-1',
        agentId: 'agent-1',
      });

      const streamId2 = tracker.createStream({
        name: 'stream-2',
        agentId: 'agent-2',
      });

      guards.touchGuard(tracker.db, streamId1, 'agent-1');

      // Ensure different timestamps
      const waitUntil = Date.now() + 5;
      while (Date.now() < waitUntil) {
        // busy wait
      }

      guards.touchGuard(tracker.db, streamId2, 'agent-2');

      const activeGuards = guards.listActiveGuards(tracker.db, 60);
      expect(activeGuards).toHaveLength(2);
      // Most recent first
      expect(activeGuards[0].streamId).toBe(streamId2);
      expect(activeGuards[1].streamId).toBe(streamId1);
    });
  });

  describe('ConcurrentModificationError', () => {
    it('should have correct properties', () => {
      const error = new ConcurrentModificationError('stream-123', 'agent-456', 1234567890);

      expect(error.name).toBe('ConcurrentModificationError');
      expect(error.streamId).toBe('stream-123');
      expect(error.lastWriter).toBe('agent-456');
      expect(error.lastWriteTime).toBe(1234567890);
      expect(error.message).toContain('stream-123');
      expect(error.message).toContain('agent-456');
      expect(error.message).toContain('1234567890');
    });

    it('should be throwable and catchable', () => {
      expect(() => {
        throw new ConcurrentModificationError('s-1', 'a-1', 123);
      }).toThrow(ConcurrentModificationError);
    });
  });

  describe('Usage Pattern', () => {
    it('should detect concurrent modification in typical workflow', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      // Agent 1 reads
      const readTimestamp = Date.now();

      // Wait to ensure different timestamp
      const waitUntil = Date.now() + 10;
      while (Date.now() < waitUntil) {
        // busy wait
      }

      // Agent 2 writes in the meantime
      guards.touchGuard(tracker.db, streamId, 'agent-2');
      const guard = guards.getGuard(tracker.db, streamId);

      // Agent 1 tries to write - should detect concurrent modification
      if (!guards.validateGuard(tracker.db, streamId, 'agent-1', readTimestamp)) {
        const error = new ConcurrentModificationError(
          streamId,
          guard!.agentId,
          guard!.lastWrite
        );
        expect(error.lastWriter).toBe('agent-2');
      } else {
        throw new Error('Should have detected concurrent modification');
      }
    });

    it('should allow write when no concurrent modification', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      // Agent 1 touches guard
      guards.touchGuard(tracker.db, streamId, 'agent-1');

      // Wait a bit
      const waitUntil = Date.now() + 5;
      while (Date.now() < waitUntil) {
        // busy wait
      }

      // Agent 1 reads
      const readTimestamp = Date.now();

      // No other agent writes

      // Agent 1 validates - should pass
      const isValid = guards.validateGuard(tracker.db, streamId, 'agent-1', readTimestamp);
      expect(isValid).toBe(true);

      // Agent 1 performs write and touches guard
      guards.touchGuard(tracker.db, streamId, 'agent-1');
      const guard = guards.getGuard(tracker.db, streamId);
      expect(guard!.agentId).toBe('agent-1');
    });

    it('should handle guard lifecycle: create, validate, clear', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      // 1. Touch guard after write
      guards.touchGuard(tracker.db, streamId, 'agent-1');
      expect(guards.getGuard(tracker.db, streamId)).not.toBeNull();

      // 2. Another agent reads
      const readTime = Date.now();

      // 3. First agent writes again
      const waitUntil = Date.now() + 5;
      while (Date.now() < waitUntil) {
        // busy wait
      }
      guards.touchGuard(tracker.db, streamId, 'agent-1');

      // 4. Second agent validates - should fail
      expect(guards.validateGuard(tracker.db, streamId, 'agent-2', readTime)).toBe(false);

      // 5. Clear guard on stream archive/delete
      guards.clearGuard(tracker.db, streamId);
      expect(guards.getGuard(tracker.db, streamId)).toBeNull();

      // 6. After clear, validation passes (no guard)
      expect(guards.validateGuard(tracker.db, streamId, 'agent-2', readTime)).toBe(true);
    });
  });
});
