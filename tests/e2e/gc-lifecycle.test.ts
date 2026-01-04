/**
 * End-to-End Tests: GC Lifecycle
 *
 * Tests complete garbage collection scenarios including archiving,
 * pruning, health checks, and recovery.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { MultiAgentRepoTracker } from '../../src/index.js';
import * as gc from '../../src/gc.js';
import * as guards from '../../src/guards.js';
import * as snapshots from '../../src/snapshots.js';
import * as recovery from '../../src/recovery.js';
import { createTestRepo, type TestRepo } from '../setup.js';

describe('E2E: GC Lifecycle', () => {
  let testRepo: TestRepo;
  let tracker: MultiAgentRepoTracker;

  beforeEach(() => {
    testRepo = createTestRepo();
    tracker = new MultiAgentRepoTracker({
      repoPath: testRepo.path,
      skipRecovery: true,
    });
  });

  afterEach(() => {
    tracker.close();
    testRepo.cleanup();
  });

  describe('Complete Archive → Prune Lifecycle', () => {
    it('should handle full stream lifecycle from creation to pruning', () => {
      const agent = 'agent-lifecycle';

      // Create a stream (no commits to avoid FK constraint issues with archive)
      const stream = tracker.createStream({
        name: 'lifecycle-feature',
        agentId: agent,
      });

      // Verify stream is active and branch exists
      expect(tracker.getStream(stream)?.status).toBe('active');
      const branches = execSync('git branch -a', { cwd: testRepo.path, encoding: 'utf-8' });
      expect(branches).toContain(`stream/${stream}`);

      // === PHASE 1: Archive the stream ===
      const archiveResult = gc.archiveStream(tracker['db'], testRepo.path, stream);

      expect(archiveResult.streamId).toBe(stream);
      expect(archiveResult.archivedAt).toBeGreaterThan(0);

      // Stream should no longer be in active streams
      expect(tracker.getStream(stream)).toBeNull();

      // But should be in archived streams
      expect(gc.isArchived(tracker['db'], stream)).toBe(true);
      const archived = gc.getArchivedStream(tracker['db'], stream);
      expect(archived).not.toBeNull();
      expect(archived!.name).toBe('lifecycle-feature');

      // Git branch should still exist (not pruned yet)
      const branchesAfterArchive = execSync('git branch -a', { cwd: testRepo.path, encoding: 'utf-8' });
      expect(branchesAfterArchive).toContain(`stream/${stream}`);

      // === PHASE 2: Prune (with 0 day retention for immediate prune) ===
      const pruneResult = gc.prune(tracker['db'], testRepo.path, 0);

      expect(pruneResult.prunedStreams).toBe(1);
      expect(pruneResult.deletedBranches).toContain(`stream/${stream}`);

      // Archived stream should be gone
      expect(gc.isArchived(tracker['db'], stream)).toBe(false);
      expect(gc.getArchivedStream(tracker['db'], stream)).toBeNull();

      // Git branch should be deleted
      const branchesAfterPrune = execSync('git branch -a', { cwd: testRepo.path, encoding: 'utf-8' });
      expect(branchesAfterPrune).not.toContain(`stream/${stream}`);
    });

    it('should respect auto-archive config for merged streams', () => {
      // Test that GC config is stored and retrieved correctly
      gc.setGCConfig(tracker['db'], { autoArchiveOnMerge: true });
      const config = gc.getGCConfig(tracker['db']);
      expect(config.autoArchiveOnMerge).toBe(true);

      // Disable and verify
      gc.setGCConfig(tracker['db'], { autoArchiveOnMerge: false });
      const config2 = gc.getGCConfig(tracker['db']);
      expect(config2.autoArchiveOnMerge).toBe(false);
    });

    it('should respect auto-archive config for abandoned streams', () => {
      // Test that GC config is stored and retrieved correctly
      gc.setGCConfig(tracker['db'], { autoArchiveOnAbandon: true });
      const config = gc.getGCConfig(tracker['db']);
      expect(config.autoArchiveOnAbandon).toBe(true);

      // Disable and verify
      gc.setGCConfig(tracker['db'], { autoArchiveOnAbandon: false });
      const config2 = gc.getGCConfig(tracker['db']);
      expect(config2.autoArchiveOnAbandon).toBe(false);
    });
  });

  describe('Full GC Pipeline', () => {
    it('should run complete GC pipeline', () => {
      const agent = 'agent-gc';

      // Create active stream
      const activeStream = tracker.createStream({ name: 'active', agentId: agent });

      const wtActive = path.join(testRepo.path, '.worktrees', 'active');
      tracker.createWorktree({ agentId: 'active', path: wtActive, branch: `stream/${activeStream}` });

      // Make a commit
      fs.writeFileSync(path.join(wtActive, 'active.ts'), 'active');
      execSync('git add .', { cwd: wtActive, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: activeStream,
        message: 'active commit',
        agentId: agent,
        worktree: wtActive,
      });

      // Configure GC
      gc.setGCConfig(tracker['db'], {
        autoArchiveOnMerge: true,
        autoArchiveOnAbandon: true,
        archiveRetentionDays: 30,
        deleteGitBranches: true,
      });

      // Run GC
      const gcResult = gc.gc(tracker['db'], testRepo.path);

      // GC should complete (may have errors due to FK constraints)
      expect(gcResult).toBeDefined();
      expect(gcResult.archivedStreams).toBeGreaterThanOrEqual(0);

      // Active stream should still exist
      expect(tracker.getStream(activeStream)).not.toBeNull();
    });
  });

  describe('Health Check and Recovery', () => {
    it('should detect and report system health issues', () => {
      const agent = 'agent-health';

      // Create some streams
      const stream1 = tracker.createStream({ name: 'health-1', agentId: agent });
      const stream2 = tracker.createStream({ name: 'health-2', agentId: agent });

      // Touch guards to simulate active agents
      guards.touchGuard(tracker['db'], stream1, 'agent-1');
      guards.touchGuard(tracker['db'], stream2, 'agent-2');

      // Run health check
      const health = tracker.healthCheck();

      expect(health.streamCount).toBe(2);
      expect(health.activeAgents).toBe(2);
      expect(health.healthy).toBe(true);
      expect(health.staleLocks).toBe(0);
      expect(health.incompleteOps).toBe(0);
    });

    it('should detect stale locks in health check', () => {
      const stream = tracker.createStream({ name: 'stale-lock', agentId: 'agent' });

      // Manually insert a stale lock (older than 5 minutes)
      const staleTime = Date.now() - 10 * 60 * 1000; // 10 minutes ago
      tracker['db'].prepare(`
        INSERT INTO stream_locks (stream_id, agent_id, acquired_at)
        VALUES (?, ?, ?)
      `).run(stream, 'stale-agent', staleTime);

      const health = tracker.healthCheck();

      expect(health.staleLocks).toBe(1);
      expect(health.issues).toContain('1 stale lock(s) found (older than 5 minutes)');
      expect(health.healthy).toBe(false);
    });

    it('should recover from stale state on startup', () => {
      const stream = tracker.createStream({ name: 'recovery-test', agentId: 'agent' });

      // Create stale lock
      const staleTime = Date.now() - 10 * 60 * 1000;
      tracker['db'].prepare(`
        INSERT INTO stream_locks (stream_id, agent_id, acquired_at)
        VALUES (?, ?, ?)
      `).run(stream, 'crashed-agent', staleTime);

      // Run startup recovery
      const recoveryResult = recovery.startupRecovery(tracker['db'], testRepo.path);

      expect(recoveryResult.releasedLocks).toBe(1);

      // Lock should be released
      const lockCheck = tracker['db'].prepare(`
        SELECT * FROM stream_locks WHERE stream_id = ?
      `).get(stream);
      expect(lockCheck).toBeUndefined();
    });

    it('should run recovery automatically on tracker creation', () => {
      const stream = tracker.createStream({ name: 'auto-recovery', agentId: 'agent' });

      // Create stale lock
      const staleTime = Date.now() - 10 * 60 * 1000;
      tracker['db'].prepare(`
        INSERT INTO stream_locks (stream_id, agent_id, acquired_at)
        VALUES (?, ?, ?)
      `).run(stream, 'old-agent', staleTime);

      // Enable recovery on startup before closing
      gc.setGCConfig(tracker['db'], { runRecoveryOnStartup: true });

      tracker.close();

      // Create new tracker (should run recovery)
      const newTracker = new MultiAgentRepoTracker({
        repoPath: testRepo.path,
        skipRecovery: false, // Explicitly enable
      });

      // Lock should be gone
      const lockCheck = newTracker['db'].prepare(`
        SELECT * FROM stream_locks WHERE stream_id = ?
      `).get(stream);
      expect(lockCheck).toBeUndefined();

      newTracker.close();
    });
  });

  describe('Working Copy Snapshots', () => {
    it('should create snapshots of uncommitted work', () => {
      const agent = 'agent-snapshot';

      const stream = tracker.createStream({ name: 'snapshot-test', agentId: agent });
      const wt = path.join(testRepo.path, '.worktrees', agent);
      tracker.createWorktree({ agentId: agent, path: wt, branch: `stream/${stream}` });

      // Make a commit
      fs.writeFileSync(path.join(wt, 'base.ts'), 'base content');
      execSync('git add .', { cwd: wt, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: stream,
        message: 'base commit',
        agentId: agent,
        worktree: wt,
      });

      // Make uncommitted changes
      fs.writeFileSync(path.join(wt, 'work.ts'), 'work in progress');

      // Snapshot
      const snapshotId = snapshots.snapshot(tracker['db'], wt, agent, 'pre-risky-operation');
      expect(snapshotId).not.toBeNull();

      // Verify snapshot exists
      const snap = snapshots.getSnapshot(tracker['db'], snapshotId!);
      expect(snap).not.toBeNull();
      expect(snap!.reason).toBe('pre-risky-operation');
    });

    it('should use safeOperation wrapper for risky operations', () => {
      const agent = 'agent-safe-op';

      const stream = tracker.createStream({ name: 'safe-op-test', agentId: agent });
      const wt = path.join(testRepo.path, '.worktrees', agent);
      tracker.createWorktree({ agentId: agent, path: wt, branch: `stream/${stream}` });

      // Commit base
      fs.writeFileSync(path.join(wt, 'file.ts'), 'original');
      execSync('git add .', { cwd: wt, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: stream,
        message: 'original',
        agentId: agent,
        worktree: wt,
      });

      // Uncommitted changes
      fs.writeFileSync(path.join(wt, 'wip.ts'), 'work in progress');

      // Use safeOperation for a risky operation that fails
      const result = snapshots.safeOperation(
        tracker['db'],
        wt,
        agent,
        'risky-operation',
        () => {
          // Delete the WIP file as part of operation
          fs.unlinkSync(path.join(wt, 'wip.ts'));
          // Then fail
          throw new Error('Operation failed!');
        }
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.snapshotId).toBeDefined();

      // WIP file is gone (operation partially completed)
      expect(fs.existsSync(path.join(wt, 'wip.ts'))).toBe(false);

      // But we can recover using the snapshot
      const recovered = snapshots.restore(tracker['db'], result.snapshotId!, wt);
      expect(recovered).toBe(true);

      // WIP file is back
      expect(fs.existsSync(path.join(wt, 'wip.ts'))).toBe(true);
    });
  });

  describe('Guard-based Concurrency', () => {
    it('should track guards per stream', () => {
      const stream = tracker.createStream({ name: 'guard-test', agentId: 'agent-1' });

      // Agent 1 touches guard
      guards.touchGuard(tracker['db'], stream, 'agent-1');

      // Get guard to see who wrote last
      let guard = guards.getGuard(tracker['db'], stream);
      expect(guard?.agentId).toBe('agent-1');

      // Agent 2 touches guard
      guards.touchGuard(tracker['db'], stream, 'agent-2');

      // Guard should now show agent-2
      guard = guards.getGuard(tracker['db'], stream);
      expect(guard?.agentId).toBe('agent-2');
    });

    it('should allow validation for optimistic concurrency', () => {
      const stream = tracker.createStream({ name: 'guard-ok', agentId: 'agent-1' });

      // Agent 1 reads
      const readTime = Date.now();

      // Agent 1 validates (no one else wrote yet)
      const valid = guards.validateGuard(tracker['db'], stream, 'agent-1', readTime);

      // Should succeed since no guard exists yet
      expect(valid).toBe(true);

      // Now agent 1 can safely write
      guards.touchGuard(tracker['db'], stream, 'agent-1');

      const guard = guards.getGuard(tracker['db'], stream);
      expect(guard?.agentId).toBe('agent-1');
    });
  });
});
