import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker } from '../src/tracker.js';
import { createTestRepo } from './setup.js';
import * as conflicts from '../src/conflicts.js';
import * as streams from '../src/streams.js';
import * as git from '../src/git/index.js';
import * as fs from 'fs';
import * as path from 'path';
import { StreamConflictedError } from '../src/errors.js';

describe('Conflict Handling', () => {
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

  describe('Conflict Record CRUD', () => {
    it('should create and retrieve a conflict record', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      const conflictId = conflicts.createConflict(tracker.db, {
        streamId,
        conflictingCommit: 'abc123',
        targetCommit: 'def456',
        conflictedFiles: ['file1.ts', 'file2.ts'],
      });

      expect(conflictId).toMatch(/^cf-/);

      const conflict = conflicts.getConflict(tracker.db, conflictId);
      expect(conflict).not.toBeNull();
      expect(conflict!.streamId).toBe(streamId);
      expect(conflict!.conflictingCommit).toBe('abc123');
      expect(conflict!.targetCommit).toBe('def456');
      expect(conflict!.conflictedFiles).toEqual(['file1.ts', 'file2.ts']);
      expect(conflict!.status).toBe('pending');
      expect(conflict!.resolvedAt).toBeNull();
      expect(conflict!.resolution).toBeNull();
    });

    it('should update conflict status', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      const conflictId = conflicts.createConflict(tracker.db, {
        streamId,
        conflictingCommit: 'abc123',
        targetCommit: 'def456',
        conflictedFiles: ['file1.ts'],
      });

      conflicts.updateConflictStatus(tracker.db, conflictId, 'in_progress');

      const conflict = conflicts.getConflict(tracker.db, conflictId);
      expect(conflict!.status).toBe('in_progress');
    });

    it('should resolve conflict with resolution details', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      const conflictId = conflicts.createConflict(tracker.db, {
        streamId,
        conflictingCommit: 'abc123',
        targetCommit: 'def456',
        conflictedFiles: ['file1.ts'],
      });

      const resolution = {
        method: 'manual' as const,
        resolvedBy: 'user-1',
        newHead: 'ghi789',
      };

      conflicts.resolveConflict(tracker.db, conflictId, resolution);

      const conflict = conflicts.getConflict(tracker.db, conflictId);
      expect(conflict!.status).toBe('resolved');
      expect(conflict!.resolvedAt).not.toBeNull();
      expect(conflict!.resolution).toEqual(resolution);
    });

    it('should abandon conflict', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      const conflictId = conflicts.createConflict(tracker.db, {
        streamId,
        conflictingCommit: 'abc123',
        targetCommit: 'def456',
        conflictedFiles: ['file1.ts'],
      });

      conflicts.abandonConflict(tracker.db, conflictId);

      const conflict = conflicts.getConflict(tracker.db, conflictId);
      expect(conflict!.status).toBe('abandoned');
    });

    it('should get conflict for stream', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      // No conflict yet
      expect(conflicts.getConflictForStream(tracker.db, streamId)).toBeNull();

      const conflictId = conflicts.createConflict(tracker.db, {
        streamId,
        conflictingCommit: 'abc123',
        targetCommit: 'def456',
        conflictedFiles: ['file1.ts'],
      });

      const conflict = conflicts.getConflictForStream(tracker.db, streamId);
      expect(conflict).not.toBeNull();
      expect(conflict!.id).toBe(conflictId);
    });

    it('should check for unresolved conflicts', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      expect(conflicts.hasUnresolvedConflict(tracker.db, streamId)).toBe(false);

      const conflictId = conflicts.createConflict(tracker.db, {
        streamId,
        conflictingCommit: 'abc123',
        targetCommit: 'def456',
        conflictedFiles: ['file1.ts'],
      });

      expect(conflicts.hasUnresolvedConflict(tracker.db, streamId)).toBe(true);

      // Resolve it
      conflicts.resolveConflict(tracker.db, conflictId, {
        method: 'manual',
        resolvedBy: 'user-1',
      });

      expect(conflicts.hasUnresolvedConflict(tracker.db, streamId)).toBe(false);
    });

    it('should list conflicts with filtering', () => {
      const streamId1 = tracker.createStream({
        name: 'stream-1',
        agentId: 'agent-1',
      });

      const streamId2 = tracker.createStream({
        name: 'stream-2',
        agentId: 'agent-1',
      });

      conflicts.createConflict(tracker.db, {
        streamId: streamId1,
        conflictingCommit: 'abc123',
        targetCommit: 'def456',
        conflictedFiles: ['file1.ts'],
      });

      const cf2 = conflicts.createConflict(tracker.db, {
        streamId: streamId2,
        conflictingCommit: 'abc123',
        targetCommit: 'def456',
        conflictedFiles: ['file2.ts'],
      });

      conflicts.resolveConflict(tracker.db, cf2, {
        method: 'manual',
        resolvedBy: 'user-1',
      });

      // List all
      const allConflicts = conflicts.listConflicts(tracker.db);
      expect(allConflicts).toHaveLength(2);

      // Filter by stream
      const stream1Conflicts = conflicts.listConflicts(tracker.db, { streamId: streamId1 });
      expect(stream1Conflicts).toHaveLength(1);

      // Filter by status
      const pendingConflicts = conflicts.listConflicts(tracker.db, { status: 'pending' });
      expect(pendingConflicts).toHaveLength(1);

      const resolvedConflicts = conflicts.listConflicts(tracker.db, { status: 'resolved' });
      expect(resolvedConflicts).toHaveLength(1);
    });

    it('should count conflicts by status', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      const cf1 = conflicts.createConflict(tracker.db, {
        streamId,
        conflictingCommit: 'abc1',
        targetCommit: 'def1',
        conflictedFiles: ['file1.ts'],
      });

      const cf2 = conflicts.createConflict(tracker.db, {
        streamId,
        conflictingCommit: 'abc2',
        targetCommit: 'def2',
        conflictedFiles: ['file2.ts'],
      });

      const cf3 = conflicts.createConflict(tracker.db, {
        streamId,
        conflictingCommit: 'abc3',
        targetCommit: 'def3',
        conflictedFiles: ['file3.ts'],
      });

      conflicts.updateConflictStatus(tracker.db, cf1, 'in_progress');
      conflicts.resolveConflict(tracker.db, cf2, { method: 'manual', resolvedBy: 'user' });

      const counts = conflicts.countConflictsByStatus(tracker.db);
      expect(counts.pending).toBe(1);
      expect(counts.in_progress).toBe(1);
      expect(counts.resolved).toBe(1);
      expect(counts.abandoned).toBe(0);
    });

    it('should delete conflict record', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      const conflictId = conflicts.createConflict(tracker.db, {
        streamId,
        conflictingCommit: 'abc123',
        targetCommit: 'def456',
        conflictedFiles: ['file1.ts'],
      });

      expect(conflicts.getConflict(tracker.db, conflictId)).not.toBeNull();

      conflicts.deleteConflict(tracker.db, conflictId);

      expect(conflicts.getConflict(tracker.db, conflictId)).toBeNull();
    });
  });

  describe('Stream Blocking', () => {
    it('should set stream to conflicted status', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      streams.setStreamConflicted(tracker.db, streamId, 'cf-test123');

      const stream = tracker.getStream(streamId);
      expect(stream!.status).toBe('conflicted');
      expect((stream!.metadata as any).conflictId).toBe('cf-test123');
    });

    it('should clear conflicted status', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      streams.setStreamConflicted(tracker.db, streamId, 'cf-test123');
      expect(tracker.getStream(streamId)!.status).toBe('conflicted');

      streams.clearStreamConflicted(tracker.db, streamId);

      const stream = tracker.getStream(streamId);
      expect(stream!.status).toBe('active');
      expect((stream!.metadata as any).conflictId).toBeUndefined();
    });

    it('should block rebase on conflicted stream', () => {
      const mainId = tracker.createStream({
        name: 'main',
        agentId: 'agent-1',
      });

      // Create worktree for main and make initial commit
      const mainWorktreePath = path.join(testRepo.path, '.worktrees', 'main-wt');
      tracker.createWorktree({
        agentId: 'main-agent',
        path: mainWorktreePath,
        branch: `stream/${mainId}`,
      });

      fs.writeFileSync(path.join(mainWorktreePath, 'initial.txt'), 'initial');
      git.stageAll({ cwd: mainWorktreePath });
      git.commit('initial', { cwd: mainWorktreePath });

      const featureId = tracker.forkStream({
        parentStreamId: mainId,
        name: 'feature',
        agentId: 'agent-1',
      });

      // Get worktree for feature
      const featureWorktreePath = path.join(testRepo.path, '.worktrees', 'feature-wt');
      tracker.createWorktree({
        agentId: 'agent-1',
        path: featureWorktreePath,
        branch: `stream/${featureId}`,
      });

      // Set feature stream conflicted
      streams.setStreamConflicted(tracker.db, featureId, 'cf-test123');

      // Try to rebase - should throw
      expect(() => {
        streams.rebaseOntoStream(tracker.db, testRepo.path, {
          sourceStream: featureId,
          targetStream: mainId,
          agentId: 'agent-1',
          worktree: featureWorktreePath,
          cascade: false,
        });
      }).toThrow(StreamConflictedError);

      tracker.deallocateWorktree('agent-1');
      tracker.deallocateWorktree('main-agent');
    });

    it('should block merge on conflicted stream', () => {
      const mainId = tracker.createStream({
        name: 'main',
        agentId: 'agent-1',
      });

      // Create worktree for main and make initial commit
      const mainWorktreePath = path.join(testRepo.path, '.worktrees', 'main-wt');
      tracker.createWorktree({
        agentId: 'main-agent',
        path: mainWorktreePath,
        branch: `stream/${mainId}`,
      });

      fs.writeFileSync(path.join(mainWorktreePath, 'initial.txt'), 'initial');
      git.stageAll({ cwd: mainWorktreePath });
      git.commit('initial', { cwd: mainWorktreePath });

      const featureId = tracker.forkStream({
        parentStreamId: mainId,
        name: 'feature',
        agentId: 'agent-1',
      });

      // Get worktree for feature
      const featureWorktreePath = path.join(testRepo.path, '.worktrees', 'feature-wt');
      tracker.createWorktree({
        agentId: 'agent-1',
        path: featureWorktreePath,
        branch: `stream/${featureId}`,
      });

      // Set feature stream conflicted
      streams.setStreamConflicted(tracker.db, featureId, 'cf-test123');

      // Try to merge - should throw
      expect(() => {
        tracker.mergeStream({
          sourceStream: featureId,
          targetStream: mainId,
          agentId: 'agent-1',
          worktree: featureWorktreePath,
        });
      }).toThrow(StreamConflictedError);

      tracker.deallocateWorktree('agent-1');
      tracker.deallocateWorktree('main-agent');
    });
  });

  describe('Recovery', () => {
    it('should find stale conflicts', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      // Create a conflict and set it to in_progress
      const conflictId = conflicts.createConflict(tracker.db, {
        streamId,
        conflictingCommit: 'abc123',
        targetCommit: 'def456',
        conflictedFiles: ['file1.ts'],
      });

      conflicts.updateConflictStatus(tracker.db, conflictId, 'in_progress');

      // Immediately it's not stale (threshold not met)
      expect(conflicts.getStaleConflicts(tracker.db, 60000)).toHaveLength(0);

      // With threshold of 0, it should be found
      expect(conflicts.getStaleConflicts(tracker.db, 0)).toHaveLength(1);
    });

    it('should recover orphaned conflicts', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      // Create a conflict and set it to in_progress
      const conflictId = conflicts.createConflict(tracker.db, {
        streamId,
        conflictingCommit: 'abc123',
        targetCommit: 'def456',
        conflictedFiles: ['file1.ts'],
      });

      conflicts.updateConflictStatus(tracker.db, conflictId, 'in_progress');
      streams.setStreamConflicted(tracker.db, streamId, conflictId);

      // Verify state before recovery
      expect(tracker.getStream(streamId)!.status).toBe('conflicted');

      // Recover with threshold of 0 (immediate)
      const result = streams.recoverOrphanedConflicts(tracker.db, 0);

      expect(result.recovered).toContain(conflictId);
      expect(result.streamsCleaned).toContain(streamId);

      // Check conflict is now abandoned
      const conflict = conflicts.getConflict(tracker.db, conflictId);
      expect(conflict!.status).toBe('abandoned');

      // Check stream is now active
      const stream = tracker.getStream(streamId);
      expect(stream!.status).toBe('active');
    });

    it('should clear conflict completely', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      const conflictId = conflicts.createConflict(tracker.db, {
        streamId,
        conflictingCommit: 'abc123',
        targetCommit: 'def456',
        conflictedFiles: ['file1.ts'],
      });

      streams.setStreamConflicted(tracker.db, streamId, conflictId);

      // Clear the conflict
      streams.clearConflict(tracker.db, streamId);

      // Conflict record should be deleted
      expect(conflicts.getConflict(tracker.db, conflictId)).toBeNull();

      // Stream should be active
      expect(tracker.getStream(streamId)!.status).toBe('active');
    });
  });
});
