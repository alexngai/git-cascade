import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker } from '../src/tracker.js';
import { createTestRepo } from './setup.js';
import * as gc from '../src/gc.js';
import * as streams from '../src/streams.js';
import * as guards from '../src/guards.js';
import { getTables } from '../src/db/tables.js';

describe('GC Configuration', () => {
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

  describe('getGCConfig', () => {
    it('should return default config when no values are set', () => {
      const config = gc.getGCConfig(tracker.db);

      expect(config.autoArchiveOnMerge).toBe(true);
      expect(config.autoArchiveOnAbandon).toBe(true);
      expect(config.archiveRetentionDays).toBe(30);
      expect(config.deleteGitBranches).toBe(true);
      expect(config.deleteWorktrees).toBe(true);
      expect(config.runRecoveryOnStartup).toBe(true);
    });

    it('should return stored values merged with defaults', () => {
      // Set some values
      gc.setGCConfig(tracker.db, {
        autoArchiveOnMerge: false,
        archiveRetentionDays: 60,
      });

      const config = gc.getGCConfig(tracker.db);

      // Custom values
      expect(config.autoArchiveOnMerge).toBe(false);
      expect(config.archiveRetentionDays).toBe(60);

      // Default values for unset keys
      expect(config.autoArchiveOnAbandon).toBe(true);
      expect(config.deleteGitBranches).toBe(true);
      expect(config.deleteWorktrees).toBe(true);
      expect(config.runRecoveryOnStartup).toBe(true);
    });
  });

  describe('setGCConfig', () => {
    it('should update a single boolean value', () => {
      gc.setGCConfig(tracker.db, { autoArchiveOnMerge: false });

      const config = gc.getGCConfig(tracker.db);
      expect(config.autoArchiveOnMerge).toBe(false);
    });

    it('should update a single numeric value', () => {
      gc.setGCConfig(tracker.db, { archiveRetentionDays: 90 });

      const config = gc.getGCConfig(tracker.db);
      expect(config.archiveRetentionDays).toBe(90);
    });

    it('should update multiple values at once', () => {
      gc.setGCConfig(tracker.db, {
        autoArchiveOnMerge: false,
        autoArchiveOnAbandon: false,
        archiveRetentionDays: 7,
        deleteGitBranches: false,
        deleteWorktrees: false,
        runRecoveryOnStartup: false,
      });

      const config = gc.getGCConfig(tracker.db);
      expect(config.autoArchiveOnMerge).toBe(false);
      expect(config.autoArchiveOnAbandon).toBe(false);
      expect(config.archiveRetentionDays).toBe(7);
      expect(config.deleteGitBranches).toBe(false);
      expect(config.deleteWorktrees).toBe(false);
      expect(config.runRecoveryOnStartup).toBe(false);
    });

    it('should overwrite previously set values', () => {
      gc.setGCConfig(tracker.db, { archiveRetentionDays: 30 });
      gc.setGCConfig(tracker.db, { archiveRetentionDays: 60 });
      gc.setGCConfig(tracker.db, { archiveRetentionDays: 90 });

      const config = gc.getGCConfig(tracker.db);
      expect(config.archiveRetentionDays).toBe(90);
    });

    it('should not affect other values when updating specific keys', () => {
      // Set all values to non-default
      gc.setGCConfig(tracker.db, {
        autoArchiveOnMerge: false,
        autoArchiveOnAbandon: false,
        archiveRetentionDays: 60,
        deleteGitBranches: false,
        deleteWorktrees: false,
        runRecoveryOnStartup: false,
      });

      // Update only one value
      gc.setGCConfig(tracker.db, { archiveRetentionDays: 90 });

      const config = gc.getGCConfig(tracker.db);
      expect(config.autoArchiveOnMerge).toBe(false);
      expect(config.autoArchiveOnAbandon).toBe(false);
      expect(config.archiveRetentionDays).toBe(90);
      expect(config.deleteGitBranches).toBe(false);
      expect(config.deleteWorktrees).toBe(false);
      expect(config.runRecoveryOnStartup).toBe(false);
    });

    it('should handle empty partial config gracefully', () => {
      gc.setGCConfig(tracker.db, {});

      const config = gc.getGCConfig(tracker.db);
      // All defaults should still be in place
      expect(config.autoArchiveOnMerge).toBe(true);
      expect(config.archiveRetentionDays).toBe(30);
    });

    it('should ignore undefined values in partial config', () => {
      gc.setGCConfig(tracker.db, { archiveRetentionDays: 60 });

      // Pass object with undefined value
      gc.setGCConfig(tracker.db, {
        autoArchiveOnMerge: undefined,
        archiveRetentionDays: 90,
      } as Partial<gc.GCConfig>);

      const config = gc.getGCConfig(tracker.db);
      expect(config.autoArchiveOnMerge).toBe(true); // Still default
      expect(config.archiveRetentionDays).toBe(90);
    });
  });

  describe('persistence', () => {
    it('should persist config across tracker instances', () => {
      // Set config on first tracker
      gc.setGCConfig(tracker.db, {
        autoArchiveOnMerge: false,
        archiveRetentionDays: 45,
      });

      tracker.close();

      // Create new tracker for same repo
      const tracker2 = new MultiAgentRepoTracker({ repoPath: testRepo.path });

      try {
        const config = gc.getGCConfig(tracker2.db);
        expect(config.autoArchiveOnMerge).toBe(false);
        expect(config.archiveRetentionDays).toBe(45);
      } finally {
        tracker2.close();
      }
    });
  });

  describe('edge cases', () => {
    it('should handle zero retention days', () => {
      gc.setGCConfig(tracker.db, { archiveRetentionDays: 0 });

      const config = gc.getGCConfig(tracker.db);
      expect(config.archiveRetentionDays).toBe(0);
    });

    it('should handle large retention days value', () => {
      gc.setGCConfig(tracker.db, { archiveRetentionDays: 365 });

      const config = gc.getGCConfig(tracker.db);
      expect(config.archiveRetentionDays).toBe(365);
    });

    it('should toggle boolean values correctly', () => {
      // Start with default (true)
      expect(gc.getGCConfig(tracker.db).deleteGitBranches).toBe(true);

      // Set to false
      gc.setGCConfig(tracker.db, { deleteGitBranches: false });
      expect(gc.getGCConfig(tracker.db).deleteGitBranches).toBe(false);

      // Set back to true
      gc.setGCConfig(tracker.db, { deleteGitBranches: true });
      expect(gc.getGCConfig(tracker.db).deleteGitBranches).toBe(true);
    });
  });
});

describe('Stream Archiving', () => {
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

  describe('archiveStream', () => {
    it('should move stream from streams to archived_streams', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      // Verify stream exists in streams table
      const stream = tracker.getStream(streamId);
      expect(stream).not.toBeNull();

      // Archive the stream
      const result = gc.archiveStream(tracker.db, testRepo.path, streamId);

      expect(result.streamId).toBe(streamId);
      expect(result.archivedAt).toBeGreaterThan(0);

      // Stream should no longer be in streams table
      const afterArchive = tracker.getStream(streamId);
      expect(afterArchive).toBeNull();

      // Stream should be in archived_streams
      const archived = gc.getArchivedStream(tracker.db, streamId);
      expect(archived).not.toBeNull();
      expect(archived!.id).toBe(streamId);
      expect(archived!.name).toBe('test-stream');
      expect(archived!.agentId).toBe('agent-1');
      expect(archived!.archivedAt).toBe(result.archivedAt);
    });

    it('should preserve all stream properties when archiving', () => {
      const streamId = tracker.createStream({
        name: 'feature-stream',
        agentId: 'agent-1',
        metadata: { priority: 'high', tags: ['test'] },
        enableStackedReview: true,
      });

      const originalStream = tracker.getStream(streamId)!;

      gc.archiveStream(tracker.db, testRepo.path, streamId);

      const archived = gc.getArchivedStream(tracker.db, streamId)!;

      expect(archived.name).toBe(originalStream.name);
      expect(archived.agentId).toBe(originalStream.agentId);
      expect(archived.baseCommit).toBe(originalStream.baseCommit);
      expect(archived.status).toBe(originalStream.status);
      expect(archived.createdAt).toBe(originalStream.createdAt);
      expect(archived.updatedAt).toBe(originalStream.updatedAt);
      expect(archived.enableStackedReview).toBe(originalStream.enableStackedReview);
      expect(archived.metadata).toEqual(originalStream.metadata);
    });

    it('should clear stream guard on archive', () => {
      const streamId = tracker.createStream({
        name: 'guarded-stream',
        agentId: 'agent-1',
      });

      // Touch the guard
      guards.touchGuard(tracker.db, streamId, 'agent-1');

      // Verify guard exists
      const guardBefore = guards.getGuard(tracker.db, streamId);
      expect(guardBefore).not.toBeNull();

      // Archive the stream
      gc.archiveStream(tracker.db, testRepo.path, streamId);

      // Guard should be cleared
      const guardAfter = guards.getGuard(tracker.db, streamId);
      expect(guardAfter).toBeNull();
    });

    it('should throw error for non-existent stream', () => {
      expect(() => {
        gc.archiveStream(tracker.db, testRepo.path, 'non-existent');
      }).toThrow('Stream not found: non-existent');
    });
  });

  describe('isArchived', () => {
    it('should return false for non-archived stream', () => {
      const streamId = tracker.createStream({
        name: 'active-stream',
        agentId: 'agent-1',
      });

      expect(gc.isArchived(tracker.db, streamId)).toBe(false);
    });

    it('should return true for archived stream', () => {
      const streamId = tracker.createStream({
        name: 'to-archive',
        agentId: 'agent-1',
      });

      gc.archiveStream(tracker.db, testRepo.path, streamId);

      expect(gc.isArchived(tracker.db, streamId)).toBe(true);
    });

    it('should return false for non-existent stream', () => {
      expect(gc.isArchived(tracker.db, 'non-existent')).toBe(false);
    });
  });

  describe('getArchivedStream', () => {
    it('should return null for non-archived stream', () => {
      const streamId = tracker.createStream({
        name: 'active-stream',
        agentId: 'agent-1',
      });

      const archived = gc.getArchivedStream(tracker.db, streamId);
      expect(archived).toBeNull();
    });

    it('should return archived stream with all properties', () => {
      const streamId = tracker.createStream({
        name: 'to-archive',
        agentId: 'agent-1',
        metadata: { key: 'value' },
      });

      gc.archiveStream(tracker.db, testRepo.path, streamId);

      const archived = gc.getArchivedStream(tracker.db, streamId);
      expect(archived).not.toBeNull();
      expect(archived!.id).toBe(streamId);
      expect(archived!.name).toBe('to-archive');
      expect(archived!.agentId).toBe('agent-1');
      expect(archived!.metadata).toEqual({ key: 'value' });
    });
  });

  describe('listArchivedStreams', () => {
    it('should return empty array when no archived streams', () => {
      const archived = gc.listArchivedStreams(tracker.db);
      expect(archived).toEqual([]);
    });

    it('should return all archived streams', () => {
      const id1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const id2 = tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });
      tracker.createStream({ name: 'stream-3', agentId: 'agent-1' });

      gc.archiveStream(tracker.db, testRepo.path, id1);
      gc.archiveStream(tracker.db, testRepo.path, id2);

      const archived = gc.listArchivedStreams(tracker.db);
      expect(archived).toHaveLength(2);
      expect(archived.map((s) => s.id)).toContain(id1);
      expect(archived.map((s) => s.id)).toContain(id2);
    });

    it('should order by archived_at DESC', () => {
      const id1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const id2 = tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });

      gc.archiveStream(tracker.db, testRepo.path, id1);
      gc.archiveStream(tracker.db, testRepo.path, id2);

      const archived = gc.listArchivedStreams(tracker.db);
      expect(archived).toHaveLength(2);
      // Verify ordering is consistent (by archived_at DESC)
      // Note: timestamps may be equal if both happen in same ms,
      // so just verify the list contains both and is sorted
      expect(archived[0].archivedAt).toBeGreaterThanOrEqual(archived[1].archivedAt);
      expect(archived.map((s) => s.id)).toContain(id1);
      expect(archived.map((s) => s.id)).toContain(id2);
    });

    it('should filter by olderThanDays', () => {
      const id1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const id2 = tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });

      gc.archiveStream(tracker.db, testRepo.path, id1);
      gc.archiveStream(tracker.db, testRepo.path, id2);

      // With olderThanDays=1, recently archived streams should NOT be returned
      // (because they're not older than 1 day)
      const recentStreams = gc.listArchivedStreams(tracker.db, { olderThanDays: 1 });
      expect(recentStreams).toHaveLength(0);

      // Without filter, all archived streams should be returned
      const allStreams = gc.listArchivedStreams(tracker.db);
      expect(allStreams).toHaveLength(2);
    });
  });
});

describe('Auto-archive Integration', () => {
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

  describe('updateStreamStatus', () => {
    it('should auto-archive on merge when autoArchiveOnMerge is true', () => {
      const streamId = tracker.createStream({
        name: 'to-merge',
        agentId: 'agent-1',
      });

      // Ensure autoArchiveOnMerge is true (default)
      gc.setGCConfig(tracker.db, { autoArchiveOnMerge: true });

      const result = streams.updateStreamStatus(
        tracker.db,
        testRepo.path,
        streamId,
        'merged'
      );

      expect(result.status).toBe('merged');
      expect(result.archived).toBeDefined();
      expect(result.archived!.streamId).toBe(streamId);

      // Stream should be archived
      expect(gc.isArchived(tracker.db, streamId)).toBe(true);
      expect(tracker.getStream(streamId)).toBeNull();
    });

    it('should not auto-archive on merge when autoArchiveOnMerge is false', () => {
      const streamId = tracker.createStream({
        name: 'to-merge',
        agentId: 'agent-1',
      });

      gc.setGCConfig(tracker.db, { autoArchiveOnMerge: false });

      const result = streams.updateStreamStatus(
        tracker.db,
        testRepo.path,
        streamId,
        'merged'
      );

      expect(result.status).toBe('merged');
      expect(result.archived).toBeUndefined();

      // Stream should still exist in streams table
      expect(gc.isArchived(tracker.db, streamId)).toBe(false);
      expect(tracker.getStream(streamId)).not.toBeNull();
    });

    it('should auto-archive on abandon when autoArchiveOnAbandon is true', () => {
      const streamId = tracker.createStream({
        name: 'to-abandon',
        agentId: 'agent-1',
      });

      gc.setGCConfig(tracker.db, { autoArchiveOnAbandon: true });

      const result = streams.updateStreamStatus(
        tracker.db,
        testRepo.path,
        streamId,
        'abandoned'
      );

      expect(result.status).toBe('abandoned');
      expect(result.archived).toBeDefined();
      expect(result.archived!.streamId).toBe(streamId);

      // Stream should be archived
      expect(gc.isArchived(tracker.db, streamId)).toBe(true);
    });

    it('should not auto-archive on abandon when autoArchiveOnAbandon is false', () => {
      const streamId = tracker.createStream({
        name: 'to-abandon',
        agentId: 'agent-1',
      });

      gc.setGCConfig(tracker.db, { autoArchiveOnAbandon: false });

      const result = streams.updateStreamStatus(
        tracker.db,
        testRepo.path,
        streamId,
        'abandoned'
      );

      expect(result.status).toBe('abandoned');
      expect(result.archived).toBeUndefined();

      // Stream should still exist in streams table
      expect(gc.isArchived(tracker.db, streamId)).toBe(false);
    });

    it('should not auto-archive for other status changes', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      // Test paused status
      const pausedResult = streams.updateStreamStatus(
        tracker.db,
        testRepo.path,
        streamId,
        'paused'
      );
      expect(pausedResult.archived).toBeUndefined();
      expect(gc.isArchived(tracker.db, streamId)).toBe(false);

      // Test active status
      const activeResult = streams.updateStreamStatus(
        tracker.db,
        testRepo.path,
        streamId,
        'active'
      );
      expect(activeResult.archived).toBeUndefined();
      expect(gc.isArchived(tracker.db, streamId)).toBe(false);
    });

    it('should throw error for non-existent stream', () => {
      expect(() => {
        streams.updateStreamStatus(
          tracker.db,
          testRepo.path,
          'non-existent',
          'merged'
        );
      }).toThrow();
    });
  });
});

describe('Prune', () => {
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

  describe('prune', () => {
    it('should return empty result when no archived streams', () => {
      const result = gc.prune(tracker.db, testRepo.path);

      expect(result.prunedStreams).toBe(0);
      expect(result.deletedBranches).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('should not prune recently archived streams', () => {
      const streamId = tracker.createStream({
        name: 'recent-stream',
        agentId: 'agent-1',
      });

      gc.archiveStream(tracker.db, testRepo.path, streamId);

      // Try to prune with 30 day retention (default)
      const result = gc.prune(tracker.db, testRepo.path);

      expect(result.prunedStreams).toBe(0);
      expect(gc.isArchived(tracker.db, streamId)).toBe(true);
    });

    it('should prune streams with olderThanDays=0', () => {
      const streamId = tracker.createStream({
        name: 'to-prune',
        agentId: 'agent-1',
      });

      gc.archiveStream(tracker.db, testRepo.path, streamId);

      // Prune with 0 day retention - should prune everything
      const result = gc.prune(tracker.db, testRepo.path, 0);

      expect(result.prunedStreams).toBe(1);
      expect(gc.isArchived(tracker.db, streamId)).toBe(false);
    });

    it('should delete git branch when deleteGitBranches is true', () => {
      const streamId = tracker.createStream({
        name: 'branch-stream',
        agentId: 'agent-1',
      });

      // Verify branch exists
      const branchName = `stream/${streamId}`;
      expect(() => {
        require('child_process').execSync(`git rev-parse --verify ${branchName}`, {
          cwd: testRepo.path,
          stdio: 'pipe',
        });
      }).not.toThrow();

      gc.archiveStream(tracker.db, testRepo.path, streamId);
      gc.setGCConfig(tracker.db, { deleteGitBranches: true });

      const result = gc.prune(tracker.db, testRepo.path, 0);

      expect(result.prunedStreams).toBe(1);
      expect(result.deletedBranches).toContain(branchName);

      // Verify branch is deleted
      expect(() => {
        require('child_process').execSync(`git rev-parse --verify ${branchName}`, {
          cwd: testRepo.path,
          stdio: 'pipe',
        });
      }).toThrow();
    });

    it('should not delete git branch when deleteGitBranches is false', () => {
      const streamId = tracker.createStream({
        name: 'keep-branch-stream',
        agentId: 'agent-1',
      });

      const branchName = `stream/${streamId}`;

      gc.archiveStream(tracker.db, testRepo.path, streamId);
      gc.setGCConfig(tracker.db, { deleteGitBranches: false });

      const result = gc.prune(tracker.db, testRepo.path, 0);

      expect(result.prunedStreams).toBe(1);
      expect(result.deletedBranches).toEqual([]);

      // Verify branch still exists
      expect(() => {
        require('child_process').execSync(`git rev-parse --verify ${branchName}`, {
          cwd: testRepo.path,
          stdio: 'pipe',
        });
      }).not.toThrow();
    });

    it('should use config archiveRetentionDays as default', () => {
      const streamId = tracker.createStream({
        name: 'config-retention',
        agentId: 'agent-1',
      });

      gc.archiveStream(tracker.db, testRepo.path, streamId);

      // Set retention to 0 days in config
      gc.setGCConfig(tracker.db, { archiveRetentionDays: 0 });

      const result = gc.prune(tracker.db, testRepo.path);

      expect(result.prunedStreams).toBe(1);
    });

    it('should prune multiple archived streams', () => {
      const id1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const id2 = tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });
      const id3 = tracker.createStream({ name: 'stream-3', agentId: 'agent-1' });

      gc.archiveStream(tracker.db, testRepo.path, id1);
      gc.archiveStream(tracker.db, testRepo.path, id2);
      gc.archiveStream(tracker.db, testRepo.path, id3);

      const result = gc.prune(tracker.db, testRepo.path, 0);

      expect(result.prunedStreams).toBe(3);
      expect(gc.listArchivedStreams(tracker.db)).toHaveLength(0);
    });

    it('should handle branch deletion errors gracefully', () => {
      const streamId = tracker.createStream({
        name: 'error-stream',
        agentId: 'agent-1',
      });

      gc.archiveStream(tracker.db, testRepo.path, streamId);

      // Manually delete the branch first
      const branchName = `stream/${streamId}`;
      require('child_process').execSync(`git branch -D ${branchName}`, {
        cwd: testRepo.path,
        stdio: 'pipe',
      });

      gc.setGCConfig(tracker.db, { deleteGitBranches: true });

      // Should not throw, should continue with pruning
      const result = gc.prune(tracker.db, testRepo.path, 0);

      expect(result.prunedStreams).toBe(1);
      // Should not report "not found" as an error
      expect(result.errors).toHaveLength(0);
    });
  });
});

describe('GC Pipeline', () => {
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

  describe('gc', () => {
    it('should return empty result on clean database', () => {
      const result = gc.gc(tracker.db, testRepo.path);

      expect(result.archivedStreams).toBe(0);
      expect(result.prunedStreams).toBe(0);
      expect(result.prunedSnapshots).toBe(0);
      expect(result.cleanedWorktrees).toBe(1); // git worktree prune always runs
      expect(result.recoveredOperations).toBe(0);
      expect(result.releasedLocks).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it('should archive merged streams when autoArchiveOnMerge is true', () => {
      const streamId = tracker.createStream({
        name: 'merged-stream',
        agentId: 'agent-1',
      });

      // Disable auto-archive during status update so we can test gc() archiving
      gc.setGCConfig(tracker.db, { autoArchiveOnMerge: false });
      tracker.updateStream(streamId, { status: 'merged' });

      // Now enable it for gc
      gc.setGCConfig(tracker.db, { autoArchiveOnMerge: true });

      const result = gc.gc(tracker.db, testRepo.path);

      expect(result.archivedStreams).toBe(1);
      expect(gc.isArchived(tracker.db, streamId)).toBe(true);
    });

    it('should archive abandoned streams when autoArchiveOnAbandon is true', () => {
      const streamId = tracker.createStream({
        name: 'abandoned-stream',
        agentId: 'agent-1',
      });

      // Disable auto-archive during status update
      gc.setGCConfig(tracker.db, { autoArchiveOnAbandon: false });
      tracker.abandonStream(streamId);

      // Now enable it for gc
      gc.setGCConfig(tracker.db, { autoArchiveOnAbandon: true });

      const result = gc.gc(tracker.db, testRepo.path);

      expect(result.archivedStreams).toBe(1);
      expect(gc.isArchived(tracker.db, streamId)).toBe(true);
    });

    it('should not archive when auto-archive is disabled', () => {
      const streamId = tracker.createStream({
        name: 'no-archive-stream',
        agentId: 'agent-1',
      });

      gc.setGCConfig(tracker.db, {
        autoArchiveOnMerge: false,
        autoArchiveOnAbandon: false,
      });

      tracker.updateStream(streamId, { status: 'merged' });

      const result = gc.gc(tracker.db, testRepo.path);

      expect(result.archivedStreams).toBe(0);
      expect(gc.isArchived(tracker.db, streamId)).toBe(false);
    });

    it('should prune old archived streams', () => {
      const streamId = tracker.createStream({
        name: 'old-stream',
        agentId: 'agent-1',
      });

      gc.archiveStream(tracker.db, testRepo.path, streamId);

      // Set retention to 0 days
      gc.setGCConfig(tracker.db, { archiveRetentionDays: 0 });

      const result = gc.gc(tracker.db, testRepo.path);

      expect(result.prunedStreams).toBe(1);
      expect(gc.isArchived(tracker.db, streamId)).toBe(false);
    });

    it('should run worktree cleanup when deleteWorktrees is true', () => {
      gc.setGCConfig(tracker.db, { deleteWorktrees: true });

      const result = gc.gc(tracker.db, testRepo.path);

      expect(result.cleanedWorktrees).toBe(1);
    });

    it('should skip worktree cleanup when deleteWorktrees is false', () => {
      gc.setGCConfig(tracker.db, { deleteWorktrees: false });

      const result = gc.gc(tracker.db, testRepo.path);

      expect(result.cleanedWorktrees).toBe(0);
    });

    it('should clean up incomplete checkpoints', () => {
      const streamId = tracker.createStream({
        name: 'checkpoint-stream',
        agentId: 'agent-1',
      });

      // Create an incomplete checkpoint
      const t = getTables(tracker.db);

      tracker.db
        .prepare(`
          INSERT INTO ${t.operation_checkpoints} (
            operation_id, stream_id, op_type, step, total_steps,
            before_state, current_state, started_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run('op-123', streamId, 'cascade-rebase', 1, 5, 'abc', 'def', Date.now());

      const result = gc.gc(tracker.db, testRepo.path);

      expect(result.recoveredOperations).toBe(1);

      // Verify checkpoint was removed
      const checkpoints = tracker.db
        .prepare(`SELECT * FROM ${t.operation_checkpoints} WHERE operation_id = ?`)
        .all('op-123');
      expect(checkpoints).toHaveLength(0);
    });

    it('should release stale locks', () => {
      const streamId = tracker.createStream({
        name: 'locked-stream',
        agentId: 'agent-1',
      });

      // Create a stale lock (more than 1 hour old)
      const t = getTables(tracker.db);

      const staleTime = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
      tracker.db
        .prepare(`INSERT INTO ${t.stream_locks} (stream_id, agent_id, acquired_at) VALUES (?, ?, ?)`)
        .run(streamId, 'agent-1', staleTime);

      const result = gc.gc(tracker.db, testRepo.path);

      expect(result.releasedLocks).toBe(1);

      // Verify lock was released
      const locks = tracker.db
        .prepare(`SELECT * FROM ${t.stream_locks} WHERE stream_id = ?`)
        .all(streamId);
      expect(locks).toHaveLength(0);
    });

    it('should not release recent locks', () => {
      const streamId = tracker.createStream({
        name: 'recent-locked-stream',
        agentId: 'agent-1',
      });

      // Create a recent lock
      const t = getTables(tracker.db);

      tracker.db
        .prepare(`INSERT INTO ${t.stream_locks} (stream_id, agent_id, acquired_at) VALUES (?, ?, ?)`)
        .run(streamId, 'agent-1', Date.now());

      const result = gc.gc(tracker.db, testRepo.path);

      expect(result.releasedLocks).toBe(0);

      // Verify lock still exists
      const locks = tracker.db
        .prepare(`SELECT * FROM ${t.stream_locks} WHERE stream_id = ?`)
        .all(streamId);
      expect(locks).toHaveLength(1);
    });

    it('should accumulate errors without failing', () => {
      // Set up a scenario that might cause errors
      gc.setGCConfig(tracker.db, { archiveRetentionDays: 0 });

      // Create and archive a stream
      const streamId = tracker.createStream({
        name: 'error-test',
        agentId: 'agent-1',
      });
      gc.archiveStream(tracker.db, testRepo.path, streamId);

      // Pre-delete the branch to cause a silent "not found" (not an error)
      const branchName = `stream/${streamId}`;
      try {
        require('child_process').execSync(`git branch -D ${branchName}`, {
          cwd: testRepo.path,
          stdio: 'pipe',
        });
      } catch {
        // Branch might not exist
      }

      // GC should complete without throwing
      const result = gc.gc(tracker.db, testRepo.path);

      expect(result.prunedStreams).toBe(1);
      // Errors array should be defined (may or may not have entries)
      expect(result.errors).toBeDefined();
    });

    it('should run full pipeline with multiple operations', () => {
      // Create some streams
      const mergedId = tracker.createStream({ name: 'merged', agentId: 'agent-1' });
      const abandonedId = tracker.createStream({ name: 'abandoned', agentId: 'agent-1' });
      const activeId = tracker.createStream({ name: 'active', agentId: 'agent-1' });

      // Disable auto-archive for manual status updates
      gc.setGCConfig(tracker.db, {
        autoArchiveOnMerge: false,
        autoArchiveOnAbandon: false,
      });

      tracker.updateStream(mergedId, { status: 'merged' });
      tracker.abandonStream(abandonedId);

      // Re-enable for gc
      gc.setGCConfig(tracker.db, {
        autoArchiveOnMerge: true,
        autoArchiveOnAbandon: true,
        archiveRetentionDays: 0, // Prune immediately
      });

      const result = gc.gc(tracker.db, testRepo.path);

      // Should archive both merged and abandoned
      expect(result.archivedStreams).toBe(2);
      // Should prune them immediately
      expect(result.prunedStreams).toBe(2);
      // Active stream should remain
      expect(tracker.getStream(activeId)).not.toBeNull();
    });
  });
});
