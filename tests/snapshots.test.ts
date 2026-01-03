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
});
