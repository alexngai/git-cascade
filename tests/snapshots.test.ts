import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { MultiAgentRepoTracker } from '../src/tracker.js';
import { createTestRepo } from './setup.js';
import * as snapshots from '../src/snapshots.js';
import * as git from '../src/git/index.js';

describe('Working Copy Snapshots', () => {
  let tracker: MultiAgentRepoTracker;
  let testRepo: ReturnType<typeof createTestRepo>;
  let repoPath: string;

  beforeEach(() => {
    testRepo = createTestRepo();
    repoPath = testRepo.path;
    tracker = new MultiAgentRepoTracker({ repoPath });
  });

  afterEach(() => {
    tracker.close();
    testRepo.cleanup();
  });

  /**
   * Helper to create uncommitted changes in the repo.
   */
  function createUncommittedChanges(filename: string, content: string): void {
    const filePath = path.join(repoPath, filename);
    fs.writeFileSync(filePath, content);
  }

  describe('snapshot()', () => {
    it('should return null when working directory is clean', () => {
      const result = snapshots.snapshot(
        tracker.db,
        repoPath,
        'agent-1',
        'test-reason'
      );

      expect(result).toBeNull();
    });

    it('should create snapshot when there are uncommitted changes', () => {
      createUncommittedChanges('test.txt', 'hello world');

      const snapshotId = snapshots.snapshot(
        tracker.db,
        repoPath,
        'agent-1',
        'pre-rebase'
      );

      expect(snapshotId).not.toBeNull();
      expect(snapshotId).toMatch(/^snap-[a-f0-9]{8}$/);

      // Working directory should be clean after snapshot
      expect(git.isClean({ cwd: repoPath })).toBe(true);
    });

    it('should record snapshot in database with correct fields', () => {
      createUncommittedChanges('test.txt', 'hello world');
      const headBefore = git.getHead({ cwd: repoPath });

      const snapshotId = snapshots.snapshot(
        tracker.db,
        repoPath,
        'agent-1',
        'pre-rebase'
      )!;

      const snap = snapshots.getSnapshot(tracker.db, snapshotId);

      expect(snap).not.toBeNull();
      expect(snap!.id).toBe(snapshotId);
      expect(snap!.worktree).toBe(repoPath);
      expect(snap!.agentId).toBe('agent-1');
      expect(snap!.reason).toBe('pre-rebase');
      expect(snap!.headAtSnapshot).toBe(headBefore);
      expect(snap!.stashRef).toBeTruthy();
      expect(snap!.createdAt).toBeGreaterThan(0);
    });

    it('should create stash with descriptive message', () => {
      createUncommittedChanges('test.txt', 'hello world');

      snapshots.snapshot(tracker.db, repoPath, 'agent-1', 'pre-rebase');

      // Verify stash was created with our message format
      const stashEntries = git.stashList({ cwd: repoPath });
      expect(stashEntries.length).toBe(1);
      expect(stashEntries[0].message).toContain('snapshot:agent-1:pre-rebase');
    });

    it('should handle staged changes', () => {
      const filePath = path.join(repoPath, 'staged.txt');
      fs.writeFileSync(filePath, 'staged content');
      git.stageAll({ cwd: repoPath });

      const snapshotId = snapshots.snapshot(
        tracker.db,
        repoPath,
        'agent-1',
        'staged-test'
      );

      expect(snapshotId).not.toBeNull();
      expect(git.isClean({ cwd: repoPath })).toBe(true);
    });

    it('should handle mixed staged and unstaged changes', () => {
      // Create a staged change
      const stagedPath = path.join(repoPath, 'staged.txt');
      fs.writeFileSync(stagedPath, 'staged content');
      git.stageAll({ cwd: repoPath });

      // Create an unstaged change
      createUncommittedChanges('unstaged.txt', 'unstaged content');

      const snapshotId = snapshots.snapshot(
        tracker.db,
        repoPath,
        'agent-1',
        'mixed-test'
      );

      expect(snapshotId).not.toBeNull();
      expect(git.isClean({ cwd: repoPath })).toBe(true);
    });
  });

  describe('restore()', () => {
    it('should restore uncommitted changes from snapshot', () => {
      createUncommittedChanges('test.txt', 'original content');
      const snapshotId = snapshots.snapshot(
        tracker.db,
        repoPath,
        'agent-1',
        'test'
      )!;

      // Verify clean after snapshot
      expect(git.isClean({ cwd: repoPath })).toBe(true);

      // Restore
      const result = snapshots.restore(tracker.db, snapshotId, repoPath);

      expect(result).toBe(true);

      // Verify file is restored
      const filePath = path.join(repoPath, 'test.txt');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('original content');
    });

    it('should return false for non-existent snapshot', () => {
      const result = snapshots.restore(
        tracker.db,
        'snap-nonexist',
        repoPath
      );

      expect(result).toBe(false);
    });

    it('should return false if stash ref is invalid', () => {
      // Create a snapshot record with an invalid stash ref
      const t = tracker.db.prepare(`
        INSERT INTO wc_snapshots (id, worktree, agent_id, reason, stash_ref, head_at_snapshot, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      t.run('snap-invalid', repoPath, 'agent-1', 'test', 'invalid-ref', 'abc123', Date.now());

      const result = snapshots.restore(tracker.db, 'snap-invalid', repoPath);

      expect(result).toBe(false);
    });

    it('should keep snapshot record after successful restore', () => {
      createUncommittedChanges('test.txt', 'content');
      const snapshotId = snapshots.snapshot(
        tracker.db,
        repoPath,
        'agent-1',
        'test'
      )!;

      snapshots.restore(tracker.db, snapshotId, repoPath);

      // Snapshot record should still exist
      const snap = snapshots.getSnapshot(tracker.db, snapshotId);
      expect(snap).not.toBeNull();
    });
  });

  describe('listSnapshots()', () => {
    it('should return empty array when no snapshots exist', () => {
      const result = snapshots.listSnapshots(tracker.db);
      expect(result).toEqual([]);
    });

    it('should list all snapshots ordered by creation time (newest first)', () => {
      createUncommittedChanges('file1.txt', 'content1');
      const id1 = snapshots.snapshot(tracker.db, repoPath, 'agent-1', 'first')!;

      // Small delay to ensure different timestamps
      createUncommittedChanges('file2.txt', 'content2');
      const id2 = snapshots.snapshot(tracker.db, repoPath, 'agent-1', 'second')!;

      const result = snapshots.listSnapshots(tracker.db);

      expect(result.length).toBe(2);
      expect(result[0].id).toBe(id2); // Newest first
      expect(result[1].id).toBe(id1);
    });

    it('should filter by worktree', () => {
      createUncommittedChanges('file1.txt', 'content');
      snapshots.snapshot(tracker.db, repoPath, 'agent-1', 'test');

      // Create record for different worktree
      tracker.db.prepare(`
        INSERT INTO wc_snapshots (id, worktree, agent_id, reason, stash_ref, head_at_snapshot, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('snap-other', '/other/path', 'agent-1', 'other', 'ref123', 'abc', Date.now());

      const result = snapshots.listSnapshots(tracker.db, { worktree: repoPath });

      expect(result.length).toBe(1);
      expect(result[0].worktree).toBe(repoPath);
    });

    it('should filter by agentId', () => {
      createUncommittedChanges('file1.txt', 'content1');
      snapshots.snapshot(tracker.db, repoPath, 'agent-1', 'test1');

      createUncommittedChanges('file2.txt', 'content2');
      snapshots.snapshot(tracker.db, repoPath, 'agent-2', 'test2');

      const result = snapshots.listSnapshots(tracker.db, { agentId: 'agent-1' });

      expect(result.length).toBe(1);
      expect(result[0].agentId).toBe('agent-1');
    });

    it('should filter by both worktree and agentId', () => {
      createUncommittedChanges('file1.txt', 'content');
      snapshots.snapshot(tracker.db, repoPath, 'agent-1', 'target');

      createUncommittedChanges('file2.txt', 'content');
      snapshots.snapshot(tracker.db, repoPath, 'agent-2', 'other-agent');

      // Record for different worktree
      tracker.db.prepare(`
        INSERT INTO wc_snapshots (id, worktree, agent_id, reason, stash_ref, head_at_snapshot, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('snap-other', '/other/path', 'agent-1', 'other-path', 'ref123', 'abc', Date.now());

      const result = snapshots.listSnapshots(tracker.db, {
        worktree: repoPath,
        agentId: 'agent-1',
      });

      expect(result.length).toBe(1);
      expect(result[0].reason).toBe('target');
    });
  });

  describe('getSnapshot()', () => {
    it('should return null for non-existent snapshot', () => {
      const result = snapshots.getSnapshot(tracker.db, 'snap-nonexist');
      expect(result).toBeNull();
    });

    it('should return snapshot with all fields', () => {
      createUncommittedChanges('test.txt', 'content');
      const snapshotId = snapshots.snapshot(
        tracker.db,
        repoPath,
        'agent-1',
        'test-reason'
      )!;

      const result = snapshots.getSnapshot(tracker.db, snapshotId);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(snapshotId);
      expect(result!.worktree).toBe(repoPath);
      expect(result!.agentId).toBe('agent-1');
      expect(result!.reason).toBe('test-reason');
      expect(result!.stashRef).toBeTruthy();
      expect(result!.headAtSnapshot).toBeTruthy();
      expect(result!.createdAt).toBeGreaterThan(0);
    });
  });

  describe('deleteSnapshot()', () => {
    it('should remove snapshot from database', () => {
      createUncommittedChanges('test.txt', 'content');
      const snapshotId = snapshots.snapshot(
        tracker.db,
        repoPath,
        'agent-1',
        'test'
      )!;

      expect(snapshots.getSnapshot(tracker.db, snapshotId)).not.toBeNull();

      snapshots.deleteSnapshot(tracker.db, snapshotId);

      expect(snapshots.getSnapshot(tracker.db, snapshotId)).toBeNull();
    });

    it('should handle deleting non-existent snapshot gracefully', () => {
      // Should not throw
      expect(() => {
        snapshots.deleteSnapshot(tracker.db, 'snap-nonexist');
      }).not.toThrow();
    });

    it('should not affect git stash (stash remains)', () => {
      createUncommittedChanges('test.txt', 'content');
      const snapshotId = snapshots.snapshot(
        tracker.db,
        repoPath,
        'agent-1',
        'test'
      )!;

      const snap = snapshots.getSnapshot(tracker.db, snapshotId)!;
      const stashRef = snap.stashRef;

      snapshots.deleteSnapshot(tracker.db, snapshotId);

      // Stash should still exist in git
      const stashList = git.stashList({ cwd: repoPath });
      expect(stashList.some((entry) => entry.ref === stashRef)).toBe(true);
    });
  });

  describe('pruneSnapshots()', () => {
    it('should return 0 when no snapshots exist', () => {
      const deleted = snapshots.pruneSnapshots(tracker.db, 30);
      expect(deleted).toBe(0);
    });

    it('should delete snapshots older than specified days', () => {
      // Create a snapshot with old timestamp
      const oldTimestamp = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago
      tracker.db.prepare(`
        INSERT INTO wc_snapshots (id, worktree, agent_id, reason, stash_ref, head_at_snapshot, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('snap-old', repoPath, 'agent-1', 'old', 'ref123', 'abc', oldTimestamp);

      // Create a recent snapshot
      createUncommittedChanges('test.txt', 'content');
      const recentId = snapshots.snapshot(
        tracker.db,
        repoPath,
        'agent-1',
        'recent'
      )!;

      const deleted = snapshots.pruneSnapshots(tracker.db, 30);

      expect(deleted).toBe(1);
      expect(snapshots.getSnapshot(tracker.db, 'snap-old')).toBeNull();
      expect(snapshots.getSnapshot(tracker.db, recentId)).not.toBeNull();
    });

    it('should keep snapshots newer than specified days', () => {
      createUncommittedChanges('test.txt', 'content');
      const snapshotId = snapshots.snapshot(
        tracker.db,
        repoPath,
        'agent-1',
        'test'
      )!;

      const deleted = snapshots.pruneSnapshots(tracker.db, 30);

      expect(deleted).toBe(0);
      expect(snapshots.getSnapshot(tracker.db, snapshotId)).not.toBeNull();
    });

    it('should delete multiple old snapshots', () => {
      const oldTimestamp = Date.now() - 100 * 24 * 60 * 60 * 1000;

      tracker.db.prepare(`
        INSERT INTO wc_snapshots (id, worktree, agent_id, reason, stash_ref, head_at_snapshot, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('snap-old1', repoPath, 'agent-1', 'old1', 'ref1', 'abc', oldTimestamp);

      tracker.db.prepare(`
        INSERT INTO wc_snapshots (id, worktree, agent_id, reason, stash_ref, head_at_snapshot, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('snap-old2', repoPath, 'agent-1', 'old2', 'ref2', 'abc', oldTimestamp);

      const deleted = snapshots.pruneSnapshots(tracker.db, 90);

      expect(deleted).toBe(2);
    });

    it('should handle edge case of 0 days', () => {
      // Create a snapshot with a timestamp 1ms in the past to ensure it's older than cutoff
      const oldTimestamp = Date.now() - 1;
      tracker.db.prepare(`
        INSERT INTO wc_snapshots (id, worktree, agent_id, reason, stash_ref, head_at_snapshot, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('snap-recent', repoPath, 'agent-1', 'test', 'ref123', 'abc', oldTimestamp);

      // All snapshots should be deleted with 0 day retention
      const deleted = snapshots.pruneSnapshots(tracker.db, 0);

      expect(deleted).toBe(1);
      expect(snapshots.listSnapshots(tracker.db)).toEqual([]);
    });
  });

  describe('persistence', () => {
    it('should persist snapshots across tracker instances', () => {
      createUncommittedChanges('test.txt', 'content');
      const snapshotId = snapshots.snapshot(
        tracker.db,
        repoPath,
        'agent-1',
        'test'
      )!;

      tracker.close();

      // Create new tracker for same repo
      const tracker2 = new MultiAgentRepoTracker({ repoPath });

      try {
        const snap = snapshots.getSnapshot(tracker2.db, snapshotId);
        expect(snap).not.toBeNull();
        expect(snap!.id).toBe(snapshotId);
        expect(snap!.reason).toBe('test');
      } finally {
        tracker2.close();
      }
    });
  });

  describe('safeOperation()', () => {
    it('should return success with result when operation succeeds', () => {
      const result = snapshots.safeOperation(
        tracker.db,
        repoPath,
        'agent-1',
        'test-op',
        () => 42
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe(42);
      expect(result.error).toBeUndefined();
    });

    it('should return success with snapshotId when uncommitted changes exist', () => {
      createUncommittedChanges('test.txt', 'content');

      const result = snapshots.safeOperation(
        tracker.db,
        repoPath,
        'agent-1',
        'test-op',
        () => 'done'
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe('done');
      expect(result.snapshotId).toMatch(/^snap-[a-f0-9]{8}$/);

      // Verify snapshot was created with pre- prefix
      const snap = snapshots.getSnapshot(tracker.db, result.snapshotId!);
      expect(snap!.reason).toBe('pre-test-op');
    });

    it('should not create snapshot when working directory is clean', () => {
      const result = snapshots.safeOperation(
        tracker.db,
        repoPath,
        'agent-1',
        'test-op',
        () => 'success'
      );

      expect(result.success).toBe(true);
      expect(result.snapshotId).toBeUndefined();
    });

    it('should return error when operation throws', () => {
      const result = snapshots.safeOperation(
        tracker.db,
        repoPath,
        'agent-1',
        'test-op',
        () => {
          throw new Error('Operation failed');
        }
      );

      expect(result.success).toBe(false);
      expect(result.result).toBeUndefined();
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error!.message).toBe('Operation failed');
    });

    it('should return snapshotId when operation fails with uncommitted changes', () => {
      createUncommittedChanges('test.txt', 'content');

      const result = snapshots.safeOperation(
        tracker.db,
        repoPath,
        'agent-1',
        'rebase',
        () => {
          throw new Error('Rebase conflict');
        }
      );

      expect(result.success).toBe(false);
      expect(result.snapshotId).toMatch(/^snap-[a-f0-9]{8}$/);
      expect(result.error!.message).toBe('Rebase conflict');

      // Working directory should be clean (snapshot captured the changes)
      expect(git.isClean({ cwd: repoPath })).toBe(true);

      // Should be able to restore using the snapshot ID
      const restored = snapshots.restore(tracker.db, result.snapshotId!, repoPath);
      expect(restored).toBe(true);

      // File should be restored
      const filePath = path.join(repoPath, 'test.txt');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('content');
    });

    it('should convert non-Error throws to Error objects', () => {
      const result = snapshots.safeOperation(
        tracker.db,
        repoPath,
        'agent-1',
        'test-op',
        () => {
          throw 'string error';
        }
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error!.message).toBe('string error');
    });

    it('should work with generic return types', () => {
      interface MyResult {
        value: number;
        name: string;
      }

      const result = snapshots.safeOperation<MyResult>(
        tracker.db,
        repoPath,
        'agent-1',
        'test-op',
        () => ({ value: 123, name: 'test' })
      );

      expect(result.success).toBe(true);
      expect(result.result).toEqual({ value: 123, name: 'test' });
    });
  });

  describe('safeOperationAsync()', () => {
    it('should return success with result when async operation succeeds', async () => {
      const result = await snapshots.safeOperationAsync(
        tracker.db,
        repoPath,
        'agent-1',
        'async-op',
        async () => {
          return Promise.resolve(42);
        }
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe(42);
      expect(result.error).toBeUndefined();
    });

    it('should return success with snapshotId when uncommitted changes exist', async () => {
      createUncommittedChanges('test.txt', 'async content');

      const result = await snapshots.safeOperationAsync(
        tracker.db,
        repoPath,
        'agent-1',
        'async-op',
        async () => 'async done'
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe('async done');
      expect(result.snapshotId).toMatch(/^snap-[a-f0-9]{8}$/);

      // Verify snapshot was created with pre- prefix
      const snap = snapshots.getSnapshot(tracker.db, result.snapshotId!);
      expect(snap!.reason).toBe('pre-async-op');
    });

    it('should not create snapshot when working directory is clean', async () => {
      const result = await snapshots.safeOperationAsync(
        tracker.db,
        repoPath,
        'agent-1',
        'async-op',
        async () => 'success'
      );

      expect(result.success).toBe(true);
      expect(result.snapshotId).toBeUndefined();
    });

    it('should return error when async operation rejects', async () => {
      const result = await snapshots.safeOperationAsync(
        tracker.db,
        repoPath,
        'agent-1',
        'async-op',
        async () => {
          throw new Error('Async operation failed');
        }
      );

      expect(result.success).toBe(false);
      expect(result.result).toBeUndefined();
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error!.message).toBe('Async operation failed');
    });

    it('should return snapshotId when async operation fails with uncommitted changes', async () => {
      createUncommittedChanges('test.txt', 'content');

      const result = await snapshots.safeOperationAsync(
        tracker.db,
        repoPath,
        'agent-1',
        'merge',
        async () => {
          throw new Error('Merge conflict');
        }
      );

      expect(result.success).toBe(false);
      expect(result.snapshotId).toMatch(/^snap-[a-f0-9]{8}$/);
      expect(result.error!.message).toBe('Merge conflict');

      // Working directory should be clean (snapshot captured the changes)
      expect(git.isClean({ cwd: repoPath })).toBe(true);

      // Should be able to restore using the snapshot ID
      const restored = snapshots.restore(tracker.db, result.snapshotId!, repoPath);
      expect(restored).toBe(true);
    });

    it('should convert non-Error rejects to Error objects', async () => {
      const result = await snapshots.safeOperationAsync(
        tracker.db,
        repoPath,
        'agent-1',
        'async-op',
        async () => {
          throw 'string error';
        }
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error!.message).toBe('string error');
    });

    it('should work with generic return types', async () => {
      interface AsyncResult {
        items: string[];
        count: number;
      }

      const result = await snapshots.safeOperationAsync<AsyncResult>(
        tracker.db,
        repoPath,
        'agent-1',
        'async-op',
        async () => ({ items: ['a', 'b'], count: 2 })
      );

      expect(result.success).toBe(true);
      expect(result.result).toEqual({ items: ['a', 'b'], count: 2 });
    });

    it('should handle rejected promises correctly', async () => {
      const result = await snapshots.safeOperationAsync(
        tracker.db,
        repoPath,
        'agent-1',
        'async-op',
        () => Promise.reject(new Error('Rejected promise'))
      );

      expect(result.success).toBe(false);
      expect(result.error!.message).toBe('Rejected promise');
    });
  });

  describe('safe operation recovery workflow', () => {
    it('should enable recovery after failed operation', () => {
      // Create some uncommitted work
      createUncommittedChanges('important-work.txt', 'valuable changes');

      // Simulate a risky operation that fails
      const result = snapshots.safeOperation(
        tracker.db,
        repoPath,
        'agent-1',
        'rebase',
        () => {
          // In a real scenario, this might be git.rebase() that fails
          throw new Error('Rebase failed due to conflicts');
        }
      );

      // Verify the operation failed but we have a recovery path
      expect(result.success).toBe(false);
      expect(result.snapshotId).toBeDefined();

      // Working directory is clean (changes were stashed)
      expect(git.isClean({ cwd: repoPath })).toBe(true);

      // Perform recovery
      const recovered = snapshots.restore(tracker.db, result.snapshotId!, repoPath);
      expect(recovered).toBe(true);

      // Verify our important work is back
      const filePath = path.join(repoPath, 'important-work.txt');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('valuable changes');
    });

    it('should allow cleanup after successful operation', () => {
      createUncommittedChanges('work.txt', 'in-progress');

      const result = snapshots.safeOperation(
        tracker.db,
        repoPath,
        'agent-1',
        'successful-op',
        () => {
          // Operation succeeds
          return 'completed';
        }
      );

      expect(result.success).toBe(true);
      expect(result.snapshotId).toBeDefined();

      // Can optionally clean up the snapshot after successful operation
      snapshots.deleteSnapshot(tracker.db, result.snapshotId!);

      // Verify snapshot is gone
      expect(snapshots.getSnapshot(tracker.db, result.snapshotId!)).toBeNull();
    });
  });
});
