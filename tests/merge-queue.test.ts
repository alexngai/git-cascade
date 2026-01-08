/**
 * Tests for merge queue functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createTestRepo, commitFile } from './setup.js';
import { MultiAgentRepoTracker } from '../src/tracker.js';
import * as git from '../src/git/index.js';

describe('Merge Queue', () => {
  let testRepo: ReturnType<typeof createTestRepo>;
  let tracker: MultiAgentRepoTracker;

  beforeEach(() => {
    testRepo = createTestRepo();
    tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });
  });

  afterEach(() => {
    tracker.close();
    testRepo.cleanup();
  });

  describe('addToMergeQueue', () => {
    it('should add a stream to the merge queue', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });

      const entryId = tracker.addToMergeQueue({
        streamId,
        agentId: 'agent-1',
      });

      expect(entryId).toBeDefined();
      expect(entryId).toMatch(/^mq-/);
    });

    it('should add stream with custom priority', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });

      const entryId = tracker.addToMergeQueue({
        streamId,
        agentId: 'agent-1',
        priority: 50,
      });

      const queue = tracker.getMergeQueue();
      const entry = queue.find((e) => e.id === entryId);
      expect(entry?.priority).toBe(50);
    });

    it('should add stream with custom target branch', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });

      // Create target branch
      const head = git.getHead({ cwd: testRepo.path });
      git.createBranch('develop', head, { cwd: testRepo.path });

      const entryId = tracker.addToMergeQueue({
        streamId,
        agentId: 'agent-1',
        targetBranch: 'develop',
      });

      const queue = tracker.getMergeQueue({ targetBranch: 'develop' });
      expect(queue.some((e) => e.id === entryId)).toBe(true);
    });

    it('should add stream with metadata', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });

      const entryId = tracker.addToMergeQueue({
        streamId,
        agentId: 'agent-1',
        metadata: { reviewedBy: 'human-1', approved: true },
      });

      const queue = tracker.getMergeQueue();
      const entry = queue.find((e) => e.id === entryId);
      expect(entry?.metadata).toEqual({ reviewedBy: 'human-1', approved: true });
    });

    it('should throw when stream does not exist', () => {
      expect(() => {
        tracker.addToMergeQueue({
          streamId: 'non-existent',
          agentId: 'agent-1',
        });
      }).toThrow(/not found/);
    });

    it('should throw when stream is already in queue', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });

      tracker.addToMergeQueue({
        streamId,
        agentId: 'agent-1',
      });

      expect(() => {
        tracker.addToMergeQueue({
          streamId,
          agentId: 'agent-1',
        });
      }).toThrow(/already in merge queue/);
    });
  });

  describe('getMergeQueue', () => {
    it('should return empty queue initially', () => {
      const queue = tracker.getMergeQueue();
      expect(queue).toHaveLength(0);
    });

    it('should return entries ordered by priority then time', () => {
      const stream1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const stream2 = tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });
      const stream3 = tracker.createStream({ name: 'stream-3', agentId: 'agent-1' });

      // Add in specific order with different priorities
      tracker.addToMergeQueue({ streamId: stream1, agentId: 'agent-1', priority: 100 });
      tracker.addToMergeQueue({ streamId: stream2, agentId: 'agent-1', priority: 50 });
      tracker.addToMergeQueue({ streamId: stream3, agentId: 'agent-1', priority: 100 });

      const queue = tracker.getMergeQueue();

      expect(queue).toHaveLength(3);
      // stream2 should be first (priority 50)
      expect(queue[0].streamId).toBe(stream2);
      // stream1 and stream3 both priority 100, stream1 added first
      expect(queue[1].streamId).toBe(stream1);
      expect(queue[2].streamId).toBe(stream3);
    });

    it('should filter by target branch', () => {
      const stream1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const stream2 = tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });

      const head = git.getHead({ cwd: testRepo.path });
      git.createBranch('develop', head, { cwd: testRepo.path });

      tracker.addToMergeQueue({ streamId: stream1, agentId: 'agent-1', targetBranch: 'main' });
      tracker.addToMergeQueue({ streamId: stream2, agentId: 'agent-1', targetBranch: 'develop' });

      const mainQueue = tracker.getMergeQueue({ targetBranch: 'main' });
      const developQueue = tracker.getMergeQueue({ targetBranch: 'develop' });

      expect(mainQueue).toHaveLength(1);
      expect(mainQueue[0].streamId).toBe(stream1);
      expect(developQueue).toHaveLength(1);
      expect(developQueue[0].streamId).toBe(stream2);
    });

    it('should filter by status', () => {
      const stream1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const stream2 = tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });

      const entry1 = tracker.addToMergeQueue({ streamId: stream1, agentId: 'agent-1' });
      tracker.addToMergeQueue({ streamId: stream2, agentId: 'agent-1' });

      // Mark first as ready
      tracker.markMergeQueueReady(entry1);

      const pendingQueue = tracker.getMergeQueue({ status: 'pending' });
      const readyQueue = tracker.getMergeQueue({ status: 'ready' });

      expect(pendingQueue).toHaveLength(1);
      expect(pendingQueue[0].streamId).toBe(stream2);
      expect(readyQueue).toHaveLength(1);
      expect(readyQueue[0].streamId).toBe(stream1);
    });

    it('should include position in queue', () => {
      const stream1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const stream2 = tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });

      tracker.addToMergeQueue({ streamId: stream1, agentId: 'agent-1' });
      tracker.addToMergeQueue({ streamId: stream2, agentId: 'agent-1' });

      const queue = tracker.getMergeQueue();

      expect(queue[0].position).toBe(1);
      expect(queue[1].position).toBe(2);
    });
  });

  describe('getMergeQueueEntry', () => {
    it('should return entry by ID', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });
      const entryId = tracker.addToMergeQueue({ streamId, agentId: 'agent-1' });

      const entry = tracker.getMergeQueueEntry(entryId);

      expect(entry).toBeDefined();
      expect(entry!.id).toBe(entryId);
      expect(entry!.streamId).toBe(streamId);
      expect(entry!.status).toBe('pending');
    });

    it('should return null for non-existent entry', () => {
      const entry = tracker.getMergeQueueEntry('non-existent');
      expect(entry).toBeNull();
    });
  });

  describe('markMergeQueueReady', () => {
    it('should change status to ready', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });
      const entryId = tracker.addToMergeQueue({ streamId, agentId: 'agent-1' });

      expect(tracker.getMergeQueueEntry(entryId)!.status).toBe('pending');

      tracker.markMergeQueueReady(entryId);

      expect(tracker.getMergeQueueEntry(entryId)!.status).toBe('ready');
    });
  });

  describe('cancelMergeQueueEntry', () => {
    it('should change status to cancelled', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });
      const entryId = tracker.addToMergeQueue({ streamId, agentId: 'agent-1' });

      tracker.cancelMergeQueueEntry(entryId);

      const entry = tracker.getMergeQueueEntry(entryId);
      expect(entry!.status).toBe('cancelled');
    });
  });

  describe('removeFromMergeQueue', () => {
    it('should remove entry from queue', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });
      const entryId = tracker.addToMergeQueue({ streamId, agentId: 'agent-1' });

      expect(tracker.getMergeQueueEntry(entryId)).toBeDefined();

      tracker.removeFromMergeQueue(entryId);

      expect(tracker.getMergeQueueEntry(entryId)).toBeNull();
    });
  });

  describe('getNextToMerge', () => {
    it('should return null when no ready entries', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });
      tracker.addToMergeQueue({ streamId, agentId: 'agent-1' }); // pending, not ready

      const next = tracker.getNextToMerge();
      expect(next).toBeNull();
    });

    it('should return highest priority ready entry', () => {
      const stream1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const stream2 = tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });

      const entry1 = tracker.addToMergeQueue({ streamId: stream1, agentId: 'agent-1', priority: 100 });
      const entry2 = tracker.addToMergeQueue({ streamId: stream2, agentId: 'agent-1', priority: 50 });

      tracker.markMergeQueueReady(entry1);
      tracker.markMergeQueueReady(entry2);

      const next = tracker.getNextToMerge();
      expect(next?.id).toBe(entry2); // priority 50 is higher than 100
    });

    it('should filter by target branch', () => {
      const stream1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const stream2 = tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });

      const head = git.getHead({ cwd: testRepo.path });
      git.createBranch('develop', head, { cwd: testRepo.path });

      const entry1 = tracker.addToMergeQueue({ streamId: stream1, agentId: 'agent-1', targetBranch: 'main' });
      const entry2 = tracker.addToMergeQueue({ streamId: stream2, agentId: 'agent-1', targetBranch: 'develop' });

      tracker.markMergeQueueReady(entry1);
      tracker.markMergeQueueReady(entry2);

      const nextMain = tracker.getNextToMerge('main');
      const nextDevelop = tracker.getNextToMerge('develop');

      expect(nextMain?.id).toBe(entry1);
      expect(nextDevelop?.id).toBe(entry2);
    });
  });

  describe('getMergeQueuePosition', () => {
    it('should return position in queue', () => {
      const stream1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const stream2 = tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });
      const stream3 = tracker.createStream({ name: 'stream-3', agentId: 'agent-1' });

      tracker.addToMergeQueue({ streamId: stream1, agentId: 'agent-1', priority: 100 });
      tracker.addToMergeQueue({ streamId: stream2, agentId: 'agent-1', priority: 50 });
      tracker.addToMergeQueue({ streamId: stream3, agentId: 'agent-1', priority: 100 });

      // stream2 is first (priority 50), stream1 second, stream3 third
      expect(tracker.getMergeQueuePosition(stream2)).toBe(1);
      expect(tracker.getMergeQueuePosition(stream1)).toBe(2);
      expect(tracker.getMergeQueuePosition(stream3)).toBe(3);
    });

    it('should return null when stream not in queue', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });
      expect(tracker.getMergeQueuePosition(streamId)).toBeNull();
    });

    it('should filter by target branch', () => {
      const stream1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const stream2 = tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });

      const head = git.getHead({ cwd: testRepo.path });
      git.createBranch('develop', head, { cwd: testRepo.path });

      tracker.addToMergeQueue({ streamId: stream1, agentId: 'agent-1', targetBranch: 'main' });
      tracker.addToMergeQueue({ streamId: stream2, agentId: 'agent-1', targetBranch: 'develop' });

      expect(tracker.getMergeQueuePosition(stream1, 'main')).toBe(1);
      expect(tracker.getMergeQueuePosition(stream1, 'develop')).toBeNull();
      expect(tracker.getMergeQueuePosition(stream2, 'develop')).toBe(1);
    });
  });

  describe('processMergeQueue', () => {
    // Note: processMergeQueue currently requires target to be a stream ID since
    // streams.mergeStream expects both source and target to be streams.
    // These tests skip the actual merge execution and focus on queue behavior.

    it('should skip non-ready entries', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });
      tracker.addToMergeQueue({ streamId, agentId: 'agent-1' }); // pending, not ready

      const wtPath = path.join(testRepo.path, '.worktrees', 'merge-agent');
      fs.mkdirSync(path.dirname(wtPath), { recursive: true });
      tracker.createWorktree({ agentId: 'merge-agent', path: wtPath });

      const result = tracker.processMergeQueue({
        agentId: 'merge-agent',
        worktree: wtPath,
      });

      // No merges attempted because entry is pending, not ready
      expect(result.merged).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
    });

    it('should mark ready entry as failed when target is not a stream', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });

      // Make a change on the stream
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'feature.txt'), 'new feature');
      git.stageAll({ cwd: testRepo.path });
      git.commit('Add feature', { cwd: testRepo.path });
      git.checkout('main', { cwd: testRepo.path });

      // Add to queue targeting 'main' branch (not a stream ID)
      const entryId = tracker.addToMergeQueue({ streamId, agentId: 'agent-1', targetBranch: 'main' });
      tracker.markMergeQueueReady(entryId);

      // Create worktree for merge
      const wtPath = path.join(testRepo.path, '.worktrees', 'merge-agent');
      fs.mkdirSync(path.dirname(wtPath), { recursive: true });
      tracker.createWorktree({ agentId: 'merge-agent', path: wtPath });

      const result = tracker.processMergeQueue({
        agentId: 'merge-agent',
        worktree: wtPath,
      });

      // Should fail because 'main' is not a valid stream ID
      expect(result.merged).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].streamId).toBe(streamId);
      expect(result.failed[0].error).toContain('not found');

      // Verify entry is marked as failed
      const entry = tracker.getMergeQueueEntry(entryId);
      expect(entry!.status).toBe('failed');
    });

    it('should only process entries for specified target branch', () => {
      const stream1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const stream2 = tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });

      // Add to different target branches
      const entry1 = tracker.addToMergeQueue({ streamId: stream1, agentId: 'agent-1', targetBranch: 'main' });
      const entry2 = tracker.addToMergeQueue({ streamId: stream2, agentId: 'agent-1', targetBranch: 'develop' });
      tracker.markMergeQueueReady(entry1);
      tracker.markMergeQueueReady(entry2);

      const wtPath = path.join(testRepo.path, '.worktrees', 'merge-agent');
      fs.mkdirSync(path.dirname(wtPath), { recursive: true });
      tracker.createWorktree({ agentId: 'merge-agent', path: wtPath });

      // Process only 'main' target
      const result = tracker.processMergeQueue({
        agentId: 'merge-agent',
        worktree: wtPath,
        targetBranch: 'main',
      });

      // Only stream1 should have been processed (and failed since 'main' isn't a stream)
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].streamId).toBe(stream1);

      // stream2's entry should still be ready (wasn't processed)
      const entry2After = tracker.getMergeQueueEntry(entry2);
      expect(entry2After!.status).toBe('ready');
    });

    it('should respect limit option', () => {
      const stream1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const stream2 = tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });

      const entry1 = tracker.addToMergeQueue({ streamId: stream1, agentId: 'agent-1' });
      const entry2 = tracker.addToMergeQueue({ streamId: stream2, agentId: 'agent-1' });
      tracker.markMergeQueueReady(entry1);
      tracker.markMergeQueueReady(entry2);

      const wtPath = path.join(testRepo.path, '.worktrees', 'merge-agent');
      fs.mkdirSync(path.dirname(wtPath), { recursive: true });
      tracker.createWorktree({ agentId: 'merge-agent', path: wtPath });

      const result = tracker.processMergeQueue({
        agentId: 'merge-agent',
        worktree: wtPath,
        limit: 1,
      });

      // Only 1 entry processed (fails because 'main' isn't a stream)
      expect(result.failed).toHaveLength(1);
      // Second entry should still be ready
      expect(tracker.getMergeQueueEntry(entry2)!.status).toBe('ready');
    });
  });

  describe('Queue Entry Properties', () => {
    it('should track added_by and timestamps', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });
      const before = Date.now();

      const entryId = tracker.addToMergeQueue({
        streamId,
        agentId: 'agent-1',
      });

      const after = Date.now();
      const entry = tracker.getMergeQueueEntry(entryId);

      expect(entry!.addedBy).toBe('agent-1');
      expect(entry!.addedAt).toBeGreaterThanOrEqual(before);
      expect(entry!.addedAt).toBeLessThanOrEqual(after);
      expect(entry!.updatedAt).toBe(entry!.addedAt);
    });

    it('should update updatedAt on status change', async () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });
      const entryId = tracker.addToMergeQueue({ streamId, agentId: 'agent-1' });

      const entryBefore = tracker.getMergeQueueEntry(entryId);
      const addedAt = entryBefore!.updatedAt;

      // Small delay to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10));

      tracker.markMergeQueueReady(entryId);

      const entryAfter = tracker.getMergeQueueEntry(entryId);
      expect(entryAfter!.updatedAt).toBeGreaterThan(addedAt);
    });
  });
});
