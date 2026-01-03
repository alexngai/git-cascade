import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker } from '../src/tracker.js';
import { createTestRepo } from './setup.js';
import * as recovery from '../src/recovery.js';
import * as git from '../src/git/index.js';
import * as guards from '../src/guards.js';
import * as snapshots from '../src/snapshots.js';
import * as conflicts from '../src/conflicts.js';
import * as gc from '../src/gc.js';
import * as streams from '../src/streams.js';
import { getTables } from '../src/db/tables.js';
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

describe('Health Check', () => {
  let tracker: MultiAgentRepoTracker;
  let testRepo: ReturnType<typeof createTestRepo>;

  beforeEach(() => {
    testRepo = createTestRepo();
    // Skip recovery in tests to avoid side effects
    tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path, skipRecovery: true });
  });

  afterEach(() => {
    tracker.close();
    testRepo.cleanup();
  });

  describe('healthCheck', () => {
    it('should return healthy status on clean database', () => {
      const result = recovery.healthCheck(tracker.db, testRepo.path);

      expect(result.healthy).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.streamCount).toBe(0);
      expect(result.archivedCount).toBe(0);
      expect(result.activeAgents).toBe(0);
      expect(result.staleLocks).toBe(0);
      expect(result.incompleteOps).toBe(0);
      expect(result.orphanedConflicts).toBe(0);
      expect(result.pendingSnapshots).toBe(0);
    });

    it('should count active streams', () => {
      tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });

      const result = recovery.healthCheck(tracker.db, testRepo.path);

      expect(result.streamCount).toBe(2);
    });

    it('should count archived streams', () => {
      const streamId = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      gc.archiveStream(tracker.db, testRepo.path, streamId);

      const result = recovery.healthCheck(tracker.db, testRepo.path);

      expect(result.streamCount).toBe(0);
      expect(result.archivedCount).toBe(1);
    });

    it('should count active agents (guards within 60s)', () => {
      const streamId = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });

      // Touch a guard (active within 60s)
      guards.touchGuard(tracker.db, streamId, 'agent-1');

      const result = recovery.healthCheck(tracker.db, testRepo.path);

      expect(result.activeAgents).toBe(1);
    });

    it('should detect stale locks (older than 5 minutes)', () => {
      const streamId = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const t = getTables(tracker.db);

      // Create a stale lock (more than 5 minutes old)
      const staleTime = Date.now() - 6 * 60 * 1000; // 6 minutes ago
      tracker.db
        .prepare(`INSERT INTO ${t.stream_locks} (stream_id, agent_id, acquired_at) VALUES (?, ?, ?)`)
        .run(streamId, 'agent-1', staleTime);

      const result = recovery.healthCheck(tracker.db, testRepo.path);

      expect(result.staleLocks).toBe(1);
      expect(result.healthy).toBe(false);
      expect(result.issues).toContain('1 stale lock(s) found (older than 5 minutes)');
    });

    it('should not flag recent locks as stale', () => {
      const streamId = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const t = getTables(tracker.db);

      // Create a recent lock
      tracker.db
        .prepare(`INSERT INTO ${t.stream_locks} (stream_id, agent_id, acquired_at) VALUES (?, ?, ?)`)
        .run(streamId, 'agent-1', Date.now());

      const result = recovery.healthCheck(tracker.db, testRepo.path);

      expect(result.staleLocks).toBe(0);
      expect(result.healthy).toBe(true);
    });

    it('should detect incomplete operations', () => {
      const streamId = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });

      recovery.checkpoint(tracker.db, {
        operationId: 'op-incomplete',
        streamId,
        opType: 'cascade_rebase',
        step: 1,
        totalSteps: 3,
        beforeState: 'abc',
        currentState: 'def',
        startedAt: Date.now(),
      });

      const result = recovery.healthCheck(tracker.db, testRepo.path);

      expect(result.incompleteOps).toBe(1);
      expect(result.healthy).toBe(false);
      expect(result.issues).toContain('1 incomplete operation(s) found');
    });

    it('should detect orphaned conflicts', () => {
      const streamId = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });

      // Create a conflict in in_progress status
      const conflictId = conflicts.createConflict(tracker.db, {
        streamId,
        conflictingCommit: 'abc123',
        targetCommit: 'def456',
        conflictedFiles: ['file.txt'],
      });

      // Set it to in_progress
      conflicts.startConflictResolution(tracker.db, conflictId, 'agent-1');

      const result = recovery.healthCheck(tracker.db, testRepo.path);

      expect(result.orphanedConflicts).toBe(1);
      expect(result.healthy).toBe(false);
      expect(result.issues).toContain('1 orphaned conflict(s) found (in_progress status)');
    });

    it('should count pending snapshots', () => {
      // Create a stream first (so we have a branch to checkout in the worktree)
      const streamId = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });

      // Create a worktree on the stream's branch
      const worktreePath = path.join(testRepo.path, '.worktrees', 'test-wt');
      tracker.createWorktree({
        agentId: 'agent-1',
        path: worktreePath,
        branch: `stream/${streamId}`,
      });

      // Create some uncommitted changes
      fs.writeFileSync(path.join(worktreePath, 'test.txt'), 'test content');

      // Create a snapshot
      snapshots.snapshot(tracker.db, worktreePath, 'agent-1', 'test-reason');

      const result = recovery.healthCheck(tracker.db, testRepo.path);

      expect(result.pendingSnapshots).toBe(1);

      // Cleanup
      tracker.deallocateWorktree('agent-1');
    });

    it('should report multiple issues', () => {
      const streamId = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const t = getTables(tracker.db);

      // Create stale lock
      const staleTime = Date.now() - 6 * 60 * 1000;
      tracker.db
        .prepare(`INSERT INTO ${t.stream_locks} (stream_id, agent_id, acquired_at) VALUES (?, ?, ?)`)
        .run(streamId, 'agent-1', staleTime);

      // Create incomplete operation
      recovery.checkpoint(tracker.db, {
        operationId: 'op-incomplete',
        streamId,
        opType: 'cascade_rebase',
        step: 1,
        totalSteps: 3,
        beforeState: 'abc',
        currentState: 'def',
        startedAt: Date.now(),
      });

      const result = recovery.healthCheck(tracker.db, testRepo.path);

      expect(result.healthy).toBe(false);
      expect(result.issues).toHaveLength(2);
    });
  });

  describe('tracker.healthCheck', () => {
    it('should expose health check via tracker', () => {
      const result = tracker.healthCheck();

      expect(result.healthy).toBe(true);
      expect(result.streamCount).toBe(0);
    });
  });
});

describe('Startup Recovery', () => {
  let tracker: MultiAgentRepoTracker;
  let testRepo: ReturnType<typeof createTestRepo>;

  beforeEach(() => {
    testRepo = createTestRepo();
    // Skip recovery in tests to control when it runs
    tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path, skipRecovery: true });
  });

  afterEach(() => {
    tracker.close();
    testRepo.cleanup();
  });

  describe('startupRecovery', () => {
    it('should return empty result on clean database', () => {
      const result = recovery.startupRecovery(tracker.db, testRepo.path);

      expect(result.recoveredOperations).toBe(0);
      expect(result.releasedLocks).toBe(0);
      expect(result.recoveredConflicts).toBe(0);
      expect(result.cleanedStreams).toBe(0);
      expect(result.log).toHaveLength(0);
    });

    it('should clear incomplete checkpoints', () => {
      const streamId = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });

      // Create incomplete checkpoints
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
        opType: 'merge',
        step: 0,
        totalSteps: 2,
        beforeState: 'xyz',
        currentState: 'xyz',
        startedAt: Date.now(),
      });

      expect(recovery.getIncompleteCheckpoints(tracker.db)).toHaveLength(2);

      const result = recovery.startupRecovery(tracker.db, testRepo.path);

      expect(result.recoveredOperations).toBe(2);
      expect(recovery.getIncompleteCheckpoints(tracker.db)).toHaveLength(0);
      expect(result.log.some((l) => l.includes('op-1'))).toBe(true);
      expect(result.log.some((l) => l.includes('op-2'))).toBe(true);
    });

    it('should release stale locks', () => {
      const streamId = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const t = getTables(tracker.db);

      // Create stale locks (more than 5 minutes old)
      const staleTime = Date.now() - 6 * 60 * 1000;
      tracker.db
        .prepare(`INSERT INTO ${t.stream_locks} (stream_id, agent_id, acquired_at) VALUES (?, ?, ?)`)
        .run(streamId, 'agent-1', staleTime);

      const result = recovery.startupRecovery(tracker.db, testRepo.path);

      expect(result.releasedLocks).toBe(1);
      expect(result.log).toContain('Released 1 stale lock(s) (older than 5 minutes)');

      // Verify lock is released
      const locks = tracker.db
        .prepare(`SELECT * FROM ${t.stream_locks} WHERE stream_id = ?`)
        .all(streamId);
      expect(locks).toHaveLength(0);
    });

    it('should not release recent locks', () => {
      const streamId = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const t = getTables(tracker.db);

      // Create a recent lock
      tracker.db
        .prepare(`INSERT INTO ${t.stream_locks} (stream_id, agent_id, acquired_at) VALUES (?, ?, ?)`)
        .run(streamId, 'agent-1', Date.now());

      const result = recovery.startupRecovery(tracker.db, testRepo.path);

      expect(result.releasedLocks).toBe(0);

      // Verify lock still exists
      const locks = tracker.db
        .prepare(`SELECT * FROM ${t.stream_locks} WHERE stream_id = ?`)
        .all(streamId);
      expect(locks).toHaveLength(1);
    });

    it('should recover orphaned conflicts', () => {
      const streamId = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });

      // Create a conflict in in_progress status with old timestamp
      const conflictId = conflicts.createConflict(tracker.db, {
        streamId,
        conflictingCommit: 'abc123',
        targetCommit: 'def456',
        conflictedFiles: ['file.txt'],
      });

      // Set it to in_progress
      conflicts.startConflictResolution(tracker.db, conflictId, 'agent-1');

      // Manually backdate the conflict to make it stale (more than 1 hour old)
      const t = getTables(tracker.db);
      const staleTime = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
      tracker.db
        .prepare(`UPDATE ${t.conflicts} SET created_at = ? WHERE id = ?`)
        .run(staleTime, conflictId);

      // Set stream to conflicted
      streams.setStreamConflicted(tracker.db, streamId, conflictId);

      const result = recovery.startupRecovery(tracker.db, testRepo.path);

      expect(result.recoveredConflicts).toBe(1);
      expect(result.cleanedStreams).toBe(1);
      expect(result.log.some((l) => l.includes(conflictId))).toBe(true);
      expect(result.log.some((l) => l.includes(streamId))).toBe(true);

      // Verify conflict is abandoned
      const conflict = conflicts.getConflict(tracker.db, conflictId);
      expect(conflict?.status).toBe('abandoned');

      // Verify stream is no longer conflicted
      const stream = tracker.getStream(streamId);
      expect(stream?.status).toBe('active');
    });

    it('should handle multiple recovery actions', () => {
      const streamId = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const t = getTables(tracker.db);

      // Create stale lock
      const staleTime = Date.now() - 6 * 60 * 1000;
      tracker.db
        .prepare(`INSERT INTO ${t.stream_locks} (stream_id, agent_id, acquired_at) VALUES (?, ?, ?)`)
        .run(streamId, 'agent-1', staleTime);

      // Create incomplete checkpoint
      recovery.checkpoint(tracker.db, {
        operationId: 'op-incomplete',
        streamId,
        opType: 'cascade_rebase',
        step: 1,
        totalSteps: 3,
        beforeState: 'abc',
        currentState: 'def',
        startedAt: Date.now(),
      });

      const result = recovery.startupRecovery(tracker.db, testRepo.path);

      expect(result.recoveredOperations).toBe(1);
      expect(result.releasedLocks).toBe(1);
      expect(result.log.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('skipRecovery option', () => {
    it('should skip recovery when skipRecovery is true', () => {
      const streamId = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const t = getTables(tracker.db);

      // Create stale lock
      const staleTime = Date.now() - 6 * 60 * 1000;
      tracker.db
        .prepare(`INSERT INTO ${t.stream_locks} (stream_id, agent_id, acquired_at) VALUES (?, ?, ?)`)
        .run(streamId, 'agent-1', staleTime);

      tracker.close();

      // Create new tracker with skipRecovery=true
      const tracker2 = new MultiAgentRepoTracker({
        repoPath: testRepo.path,
        skipRecovery: true,
      });

      // Lock should still exist
      const locks = tracker2.db
        .prepare(`SELECT * FROM ${t.stream_locks} WHERE stream_id = ?`)
        .all(streamId);
      expect(locks).toHaveLength(1);

      tracker2.close();
    });

    it('should run recovery when skipRecovery is false and config allows', () => {
      const streamId = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const t = getTables(tracker.db);

      // Ensure runRecoveryOnStartup is true
      gc.setGCConfig(tracker.db, { runRecoveryOnStartup: true });

      // Create stale lock
      const staleTime = Date.now() - 6 * 60 * 1000;
      tracker.db
        .prepare(`INSERT INTO ${t.stream_locks} (stream_id, agent_id, acquired_at) VALUES (?, ?, ?)`)
        .run(streamId, 'agent-1', staleTime);

      tracker.close();

      // Create new tracker without skipRecovery (default behavior)
      const tracker2 = new MultiAgentRepoTracker({
        repoPath: testRepo.path,
        // skipRecovery defaults to false
      });

      // Lock should be released
      const locks = tracker2.db
        .prepare(`SELECT * FROM ${t.stream_locks} WHERE stream_id = ?`)
        .all(streamId);
      expect(locks).toHaveLength(0);

      tracker2.close();
    });

    it('should skip recovery when config runRecoveryOnStartup is false', () => {
      const streamId = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const t = getTables(tracker.db);

      // Disable recovery in config
      gc.setGCConfig(tracker.db, { runRecoveryOnStartup: false });

      // Create stale lock
      const staleTime = Date.now() - 6 * 60 * 1000;
      tracker.db
        .prepare(`INSERT INTO ${t.stream_locks} (stream_id, agent_id, acquired_at) VALUES (?, ?, ?)`)
        .run(streamId, 'agent-1', staleTime);

      tracker.close();

      // Create new tracker - recovery should be skipped because config says so
      const tracker2 = new MultiAgentRepoTracker({
        repoPath: testRepo.path,
        // skipRecovery defaults to false, but config overrides
      });

      // Lock should still exist
      const locks = tracker2.db
        .prepare(`SELECT * FROM ${t.stream_locks} WHERE stream_id = ?`)
        .all(streamId);
      expect(locks).toHaveLength(1);

      tracker2.close();
    });
  });
});
