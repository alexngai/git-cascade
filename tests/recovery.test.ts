import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker } from '../src/tracker.js';
import { createTestRepo } from './setup.js';
import * as recovery from '../src/recovery.js';
import * as git from '../src/git/index.js';
import * as fs from 'fs';
import * as path from 'path';

describe('Recovery - Operation Checkpoints', () => {
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

  describe('Checkpoint CRUD', () => {
    it('should create and retrieve a checkpoint', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      const checkpointData: recovery.OperationCheckpoint = {
        operationId: 'op-test-123',
        streamId,
        opType: 'cascade_rebase',
        step: 0,
        totalSteps: 3,
        beforeState: 'abc123',
        currentState: 'abc123',
        startedAt: Date.now(),
      };

      recovery.checkpoint(tracker.db, checkpointData);

      const retrieved = recovery.getCheckpoint(tracker.db, 'op-test-123');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.operationId).toBe('op-test-123');
      expect(retrieved!.streamId).toBe(streamId);
      expect(retrieved!.opType).toBe('cascade_rebase');
      expect(retrieved!.step).toBe(0);
      expect(retrieved!.totalSteps).toBe(3);
      expect(retrieved!.beforeState).toBe('abc123');
      expect(retrieved!.currentState).toBe('abc123');
    });

    it('should update checkpoint on upsert', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      const checkpointData: recovery.OperationCheckpoint = {
        operationId: 'op-test-123',
        streamId,
        opType: 'cascade_rebase',
        step: 0,
        totalSteps: 3,
        beforeState: 'abc123',
        currentState: 'abc123',
        startedAt: Date.now(),
      };

      recovery.checkpoint(tracker.db, checkpointData);

      // Update to step 1
      recovery.checkpoint(tracker.db, {
        ...checkpointData,
        step: 1,
        currentState: 'def456',
      });

      const retrieved = recovery.getCheckpoint(tracker.db, 'op-test-123');
      expect(retrieved!.step).toBe(1);
      expect(retrieved!.currentState).toBe('def456');
      expect(retrieved!.beforeState).toBe('abc123'); // unchanged
    });

    it('should complete (delete) checkpoint', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      recovery.checkpoint(tracker.db, {
        operationId: 'op-test-123',
        streamId,
        opType: 'cascade_rebase',
        step: 3,
        totalSteps: 3,
        beforeState: 'abc123',
        currentState: 'ghi789',
        startedAt: Date.now(),
      });

      expect(recovery.getCheckpoint(tracker.db, 'op-test-123')).not.toBeNull();

      recovery.completeCheckpoint(tracker.db, 'op-test-123');

      expect(recovery.getCheckpoint(tracker.db, 'op-test-123')).toBeNull();
    });

    it('should return null for non-existent checkpoint', () => {
      const retrieved = recovery.getCheckpoint(tracker.db, 'non-existent');
      expect(retrieved).toBeNull();
    });
  });

  describe('Incomplete Checkpoints', () => {
    it('should find incomplete checkpoints', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      // Incomplete checkpoint (step < totalSteps)
      recovery.checkpoint(tracker.db, {
        operationId: 'op-incomplete-1',
        streamId,
        opType: 'cascade_rebase',
        step: 1,
        totalSteps: 3,
        beforeState: 'abc123',
        currentState: 'def456',
        startedAt: Date.now() - 1000,
      });

      // Complete checkpoint (step = totalSteps)
      recovery.checkpoint(tracker.db, {
        operationId: 'op-complete-1',
        streamId,
        opType: 'cascade_rebase',
        step: 3,
        totalSteps: 3,
        beforeState: 'xyz',
        currentState: 'xyz',
        startedAt: Date.now(),
      });

      const incomplete = recovery.getIncompleteCheckpoints(tracker.db);
      expect(incomplete).toHaveLength(1);
      expect(incomplete[0].operationId).toBe('op-incomplete-1');
    });

    it('should return empty array when no incomplete checkpoints', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      recovery.checkpoint(tracker.db, {
        operationId: 'op-complete',
        streamId,
        opType: 'cascade_rebase',
        step: 3,
        totalSteps: 3,
        beforeState: 'abc123',
        currentState: 'def456',
        startedAt: Date.now(),
      });

      const incomplete = recovery.getIncompleteCheckpoints(tracker.db);
      expect(incomplete).toHaveLength(0);
    });

    it('should order incomplete checkpoints by started_at', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      const baseTime = Date.now();

      recovery.checkpoint(tracker.db, {
        operationId: 'op-newer',
        streamId,
        opType: 'cascade_rebase',
        step: 1,
        totalSteps: 3,
        beforeState: 'abc',
        currentState: 'def',
        startedAt: baseTime + 1000,
      });

      recovery.checkpoint(tracker.db, {
        operationId: 'op-older',
        streamId,
        opType: 'cascade_rebase',
        step: 1,
        totalSteps: 3,
        beforeState: 'xyz',
        currentState: 'xyz',
        startedAt: baseTime - 1000,
      });

      const incomplete = recovery.getIncompleteCheckpoints(tracker.db);
      expect(incomplete).toHaveLength(2);
      expect(incomplete[0].operationId).toBe('op-older');
      expect(incomplete[1].operationId).toBe('op-newer');
    });
  });

  describe('Get All Checkpoints', () => {
    it('should get all checkpoints including complete ones', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      recovery.checkpoint(tracker.db, {
        operationId: 'op-1',
        streamId,
        opType: 'cascade_rebase',
        step: 1,
        totalSteps: 3,
        beforeState: 'abc',
        currentState: 'def',
        startedAt: Date.now(),
      });

      recovery.checkpoint(tracker.db, {
        operationId: 'op-2',
        streamId,
        opType: 'cascade_rebase',
        step: 3,
        totalSteps: 3,
        beforeState: 'xyz',
        currentState: 'xyz',
        startedAt: Date.now(),
      });

      const all = recovery.getAllCheckpoints(tracker.db);
      expect(all).toHaveLength(2);
    });
  });

  describe('Stream-specific Operations', () => {
    it('should get checkpoints for a specific stream', () => {
      const streamId1 = tracker.createStream({
        name: 'stream-1',
        agentId: 'agent-1',
      });

      const streamId2 = tracker.createStream({
        name: 'stream-2',
        agentId: 'agent-1',
      });

      recovery.checkpoint(tracker.db, {
        operationId: 'op-stream1',
        streamId: streamId1,
        opType: 'cascade_rebase',
        step: 1,
        totalSteps: 3,
        beforeState: 'abc',
        currentState: 'def',
        startedAt: Date.now(),
      });

      recovery.checkpoint(tracker.db, {
        operationId: 'op-stream2',
        streamId: streamId2,
        opType: 'cascade_rebase',
        step: 1,
        totalSteps: 3,
        beforeState: 'xyz',
        currentState: 'xyz',
        startedAt: Date.now(),
      });

      const stream1Checkpoints = recovery.getCheckpointsForStream(tracker.db, streamId1);
      expect(stream1Checkpoints).toHaveLength(1);
      expect(stream1Checkpoints[0].operationId).toBe('op-stream1');

      const stream2Checkpoints = recovery.getCheckpointsForStream(tracker.db, streamId2);
      expect(stream2Checkpoints).toHaveLength(1);
      expect(stream2Checkpoints[0].operationId).toBe('op-stream2');
    });

    it('should delete all checkpoints for a stream', () => {
      const streamId1 = tracker.createStream({
        name: 'stream-1',
        agentId: 'agent-1',
      });

      const streamId2 = tracker.createStream({
        name: 'stream-2',
        agentId: 'agent-1',
      });

      recovery.checkpoint(tracker.db, {
        operationId: 'op-stream1-a',
        streamId: streamId1,
        opType: 'cascade_rebase',
        step: 1,
        totalSteps: 3,
        beforeState: 'abc',
        currentState: 'def',
        startedAt: Date.now(),
      });

      recovery.checkpoint(tracker.db, {
        operationId: 'op-stream1-b',
        streamId: streamId1,
        opType: 'cascade_rebase',
        step: 2,
        totalSteps: 3,
        beforeState: 'ghi',
        currentState: 'jkl',
        startedAt: Date.now(),
      });

      recovery.checkpoint(tracker.db, {
        operationId: 'op-stream2',
        streamId: streamId2,
        opType: 'cascade_rebase',
        step: 1,
        totalSteps: 3,
        beforeState: 'xyz',
        currentState: 'xyz',
        startedAt: Date.now(),
      });

      // Delete stream1 checkpoints
      recovery.deleteCheckpointsForStream(tracker.db, streamId1);

      // Stream1 should have no checkpoints
      expect(recovery.getCheckpointsForStream(tracker.db, streamId1)).toHaveLength(0);

      // Stream2 should still have its checkpoint
      expect(recovery.getCheckpointsForStream(tracker.db, streamId2)).toHaveLength(1);
    });
  });

  describe('Recovery from Crash', () => {
    it('should recover checkpoint by resetting to before_state', () => {
      // Create a stream with a worktree
      const mainStreamId = tracker.createStream({
        name: 'main',
        agentId: 'agent-1',
      });

      // Create worktree
      const worktreePath = path.join(testRepo.path, '.worktrees', 'test-wt');
      tracker.createWorktree({
        agentId: 'agent-1',
        path: worktreePath,
        branch: `stream/${mainStreamId}`,
      });

      // Get initial commit
      const beforeState = git.getHead({ cwd: worktreePath });

      // Make a change and commit
      fs.writeFileSync(path.join(worktreePath, 'test.txt'), 'test content');
      git.stageAll({ cwd: worktreePath });
      git.commit('test commit', { cwd: worktreePath });
      const afterCommit = git.getHead({ cwd: worktreePath });

      // Verify we're at the new commit
      expect(afterCommit).not.toBe(beforeState);
      expect(git.getHead({ cwd: worktreePath })).toBe(afterCommit);

      // Create a checkpoint simulating a crashed operation
      const checkpointData: recovery.OperationCheckpoint = {
        operationId: 'op-crashed',
        streamId: mainStreamId,
        opType: 'cascade_rebase',
        step: 1,
        totalSteps: 3,
        beforeState,
        currentState: afterCommit,
        startedAt: Date.now(),
      };

      recovery.checkpoint(tracker.db, checkpointData);

      // Recover - should reset to before_state
      recovery.recoverCheckpoint(tracker.db, testRepo.path, checkpointData, worktreePath);

      // Verify we're back at the before_state
      expect(git.getHead({ cwd: worktreePath })).toBe(beforeState);

      // Verify checkpoint was removed
      expect(recovery.getCheckpoint(tracker.db, 'op-crashed')).toBeNull();

      // Cleanup
      tracker.deallocateWorktree('agent-1');
    });

    it('should handle recovery workflow for incomplete operations', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      // Create worktree
      const worktreePath = path.join(testRepo.path, '.worktrees', 'test-wt');
      tracker.createWorktree({
        agentId: 'agent-1',
        path: worktreePath,
        branch: `stream/${streamId}`,
      });

      const beforeState = git.getHead({ cwd: worktreePath });

      // Make some changes
      fs.writeFileSync(path.join(worktreePath, 'file1.txt'), 'content 1');
      git.stageAll({ cwd: worktreePath });
      git.commit('commit 1', { cwd: worktreePath });

      const midState = git.getHead({ cwd: worktreePath });

      // Simulate an incomplete operation checkpoint
      recovery.checkpoint(tracker.db, {
        operationId: 'op-incomplete',
        streamId,
        opType: 'cascade_rebase',
        step: 2,
        totalSteps: 5,
        beforeState,
        currentState: midState,
        startedAt: Date.now() - 60000, // started a minute ago
      });

      // On "restart", find incomplete checkpoints
      const incomplete = recovery.getIncompleteCheckpoints(tracker.db);
      expect(incomplete).toHaveLength(1);
      expect(incomplete[0].operationId).toBe('op-incomplete');

      // Recover each incomplete operation
      for (const cp of incomplete) {
        recovery.recoverCheckpoint(tracker.db, testRepo.path, cp, worktreePath);
      }

      // Verify recovery
      expect(git.getHead({ cwd: worktreePath })).toBe(beforeState);
      expect(recovery.getIncompleteCheckpoints(tracker.db)).toHaveLength(0);

      // Cleanup
      tracker.deallocateWorktree('agent-1');
    });
  });

  describe('Multiple Operations', () => {
    it('should track multiple concurrent operations', () => {
      const streamId1 = tracker.createStream({
        name: 'stream-1',
        agentId: 'agent-1',
      });

      const streamId2 = tracker.createStream({
        name: 'stream-2',
        agentId: 'agent-2',
      });

      // Operation 1 - in progress
      recovery.checkpoint(tracker.db, {
        operationId: 'op-1',
        streamId: streamId1,
        opType: 'cascade_rebase',
        step: 2,
        totalSteps: 5,
        beforeState: 'state1-before',
        currentState: 'state1-current',
        startedAt: Date.now(),
      });

      // Operation 2 - just started
      recovery.checkpoint(tracker.db, {
        operationId: 'op-2',
        streamId: streamId2,
        opType: 'merge',
        step: 0,
        totalSteps: 2,
        beforeState: 'state2-before',
        currentState: 'state2-before',
        startedAt: Date.now(),
      });

      const all = recovery.getAllCheckpoints(tracker.db);
      expect(all).toHaveLength(2);

      const incomplete = recovery.getIncompleteCheckpoints(tracker.db);
      expect(incomplete).toHaveLength(2);

      // Complete operation 2
      recovery.checkpoint(tracker.db, {
        operationId: 'op-2',
        streamId: streamId2,
        opType: 'merge',
        step: 2,
        totalSteps: 2,
        beforeState: 'state2-before',
        currentState: 'state2-final',
        startedAt: Date.now(),
      });

      const incompleteAfter = recovery.getIncompleteCheckpoints(tracker.db);
      expect(incompleteAfter).toHaveLength(1);
      expect(incompleteAfter[0].operationId).toBe('op-1');
    });
  });
});
