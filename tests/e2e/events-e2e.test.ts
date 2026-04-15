/**
 * End-to-End Tests: Cascade Event Emission
 *
 * Exercises a realistic multi-agent workflow with an emit callback attached
 * and validates that the resulting event stream accurately reflects the
 * operations performed. Complements tests/events.test.ts which tests each
 * event in isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  MultiAgentRepoTracker,
  CASCADE_METHODS,
  type CascadeEmitter,
  type StreamOpenedParams,
  type StreamCommittedParams,
  type StreamMergedParams,
  type StreamConflictedParams,
  type StreamAbandonedParams,
  type CascadeRebasedParams,
  type CascadeCompletedParams,
} from '../../src/index.js';
import { createTestRepo, type TestRepo } from '../setup.js';

interface CapturedEvent {
  method: string;
  params: unknown;
}

function createCapturingEmitter(): {
  emit: CascadeEmitter;
  events: CapturedEvent[];
} {
  const events: CapturedEvent[] = [];
  const emit: CascadeEmitter = (method, params) => {
    events.push({ method, params });
  };
  return { emit, events };
}

function eventsOfType(events: CapturedEvent[], method: string): CapturedEvent[] {
  return events.filter((e) => e.method === method);
}

describe('E2E: Cascade Event Emission', () => {
  let testRepo: TestRepo;

  beforeEach(() => {
    testRepo = createTestRepo();
  });

  afterEach(() => {
    testRepo.cleanup();
  });

  it('emits a coherent event sequence across a full multi-agent lifecycle', () => {
    const { emit, events } = createCapturingEmitter();
    const tracker = new MultiAgentRepoTracker({
      repoPath: testRepo.path,
      emit,
      skipRecovery: true,
    });

    try {
      // === Agent A opens a parent stream ===
      const agentA = 'agent-alpha';
      const worktreeA = path.join(testRepo.path, '.worktrees', agentA);
      const parentId = tracker.createStream({
        name: 'feature-auth',
        agentId: agentA,
        metadata: { task_ref: { resource_id: 'tasks', node_id: 'auth-root' } },
      });
      tracker.createWorktree({
        agentId: agentA,
        path: worktreeA,
        branch: `stream/${parentId}`,
      });

      // Two commits on the parent stream
      fs.writeFileSync(path.join(worktreeA, 'auth.ts'), 'export function login() {}\n');
      execSync('git add .', { cwd: worktreeA, stdio: 'pipe' });
      const c1 = tracker.commitChanges({
        streamId: parentId,
        agentId: agentA,
        worktree: worktreeA,
        message: 'feat: add login',
        metadata: { task_ref: { resource_id: 'tasks', node_id: 'auth-login' } },
      });

      fs.writeFileSync(
        path.join(worktreeA, 'auth.ts'),
        'export function login() {}\nexport function logout() {}\n'
      );
      execSync('git add .', { cwd: worktreeA, stdio: 'pipe' });
      const c2 = tracker.commitChanges({
        streamId: parentId,
        agentId: agentA,
        worktree: worktreeA,
        message: 'feat: add logout',
        metadata: { task_ref: { resource_id: 'tasks', node_id: 'auth-logout' } },
      });

      // === Agent B forks and commits on a child stream ===
      const agentB = 'agent-beta';
      const worktreeB = path.join(testRepo.path, '.worktrees', agentB);
      const childId = tracker.forkStream({
        parentStreamId: parentId,
        name: 'auth-tests',
        agentId: agentB,
      });
      tracker.createWorktree({
        agentId: agentB,
        path: worktreeB,
        branch: `stream/${childId}`,
      });

      fs.writeFileSync(
        path.join(worktreeB, 'auth.test.ts'),
        'test("login", () => {});\n'
      );
      execSync('git add .', { cwd: worktreeB, stdio: 'pipe' });
      const c3 = tracker.commitChanges({
        streamId: childId,
        agentId: agentB,
        worktree: worktreeB,
        message: 'test: login',
      });

      // === Agent B abandons the child stream ===
      tracker.abandonStream(childId, { reason: 'superseded-by-e2e-suite' });

      // ── Validate event stream ────────────────────────────────────────────

      // Exactly 2 opened events: parent + child fork.
      const opened = eventsOfType(events, CASCADE_METHODS.STREAM_OPENED);
      expect(opened).toHaveLength(2);

      const parentOpened = opened[0].params as StreamOpenedParams;
      expect(parentOpened.stream_id).toBe(parentId);
      expect(parentOpened.agent_id).toBe(agentA);
      expect(parentOpened.parent_stream).toBeUndefined();
      expect(parentOpened.branch_name).toBe(`stream/${parentId}`);
      expect(parentOpened.metadata).toMatchObject({
        task_ref: { resource_id: 'tasks', node_id: 'auth-root' },
      });

      const childOpened = opened[1].params as StreamOpenedParams;
      expect(childOpened.stream_id).toBe(childId);
      expect(childOpened.agent_id).toBe(agentB);
      expect(childOpened.parent_stream).toBe(parentId);

      // Exactly 3 committed events with correct commit hashes + change ids.
      const committed = eventsOfType(events, CASCADE_METHODS.STREAM_COMMITTED);
      expect(committed).toHaveLength(3);

      const p1 = committed[0].params as StreamCommittedParams;
      expect(p1.commit_hash).toBe(c1.commit);
      expect(p1.change_id).toBe(c1.changeId);
      expect(p1.stream_id).toBe(parentId);
      expect(p1.message_summary).toBe('feat: add login');
      expect(p1.files_touched).toContain('auth.ts');
      expect(p1.metadata).toMatchObject({
        task_ref: { resource_id: 'tasks', node_id: 'auth-login' },
      });

      const p2 = committed[1].params as StreamCommittedParams;
      expect(p2.commit_hash).toBe(c2.commit);
      expect(p2.parent_commit).toBe(c1.commit);
      expect(p2.change_id).toBe(c2.changeId);
      expect(p2.message_summary).toBe('feat: add logout');

      const p3 = committed[2].params as StreamCommittedParams;
      expect(p3.commit_hash).toBe(c3.commit);
      expect(p3.stream_id).toBe(childId);
      expect(p3.agent_id).toBe(agentB);
      expect(p3.files_touched).toContain('auth.test.ts');

      // Change-Ids are unique and survive identity on the Change records.
      expect(new Set([p1.change_id, p2.change_id, p3.change_id]).size).toBe(3);

      // Exactly 1 abandoned event for the child stream.
      const abandoned = eventsOfType(events, CASCADE_METHODS.STREAM_ABANDONED);
      expect(abandoned).toHaveLength(1);
      const a1 = abandoned[0].params as StreamAbandonedParams;
      expect(a1.stream_id).toBe(childId);
      expect(a1.reason).toBe('superseded-by-e2e-suite');

      // Overall event order matches the operation order.
      expect(events.map((e) => e.method)).toEqual([
        CASCADE_METHODS.STREAM_OPENED,       // parent
        CASCADE_METHODS.STREAM_COMMITTED,    // c1
        CASCADE_METHODS.STREAM_COMMITTED,    // c2
        CASCADE_METHODS.STREAM_OPENED,       // child fork
        CASCADE_METHODS.STREAM_COMMITTED,    // c3
        CASCADE_METHODS.STREAM_ABANDONED,    // child abandoned
      ]);
    } finally {
      tracker.close();
    }
  });

  it('emits stream.conflicted when a rebase hits conflicts', () => {
    const { emit, events } = createCapturingEmitter();
    const tracker = new MultiAgentRepoTracker({
      repoPath: testRepo.path,
      emit,
      skipRecovery: true,
    });

    try {
      const agentA = 'agent-alpha';
      const agentB = 'agent-beta';
      const worktreeA = path.join(testRepo.path, '.worktrees', agentA);
      const worktreeB = path.join(testRepo.path, '.worktrees', agentB);

      const streamA = tracker.createStream({ name: 'base', agentId: agentA });
      tracker.createWorktree({ agentId: agentA, path: worktreeA, branch: `stream/${streamA}` });

      // Initial commit on parent so conflict can happen against a known file
      fs.writeFileSync(path.join(worktreeA, 'shared.txt'), 'A\n');
      execSync('git add .', { cwd: worktreeA, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: streamA,
        agentId: agentA,
        worktree: worktreeA,
        message: 'base: init shared.txt',
      });

      // Child forks, changes shared.txt
      const streamB = tracker.forkStream({
        parentStreamId: streamA,
        name: 'child',
        agentId: agentB,
      });
      tracker.createWorktree({ agentId: agentB, path: worktreeB, branch: `stream/${streamB}` });
      fs.writeFileSync(path.join(worktreeB, 'shared.txt'), 'B-child\n');
      execSync('git add .', { cwd: worktreeB, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: streamB,
        agentId: agentB,
        worktree: worktreeB,
        message: 'child: modify shared.txt',
      });

      // Parent changes the same line in shared.txt
      fs.writeFileSync(path.join(worktreeA, 'shared.txt'), 'A-parent\n');
      execSync('git add .', { cwd: worktreeA, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: streamA,
        agentId: agentA,
        worktree: worktreeA,
        message: 'parent: modify shared.txt',
      });

      // Child syncs with parent → conflict expected
      events.length = 0;
      const result = tracker.syncWithParent(streamB, agentB, worktreeB, 'abort');
      expect(result.success).toBe(false);
      expect(result.conflicts?.length ?? 0).toBeGreaterThan(0);

      const conflicted = eventsOfType(events, CASCADE_METHODS.STREAM_CONFLICTED);
      expect(conflicted).toHaveLength(1);
      const cp = conflicted[0].params as StreamConflictedParams;
      expect(cp.stream_id).toBe(streamB);
      expect(cp.agent_id).toBe(agentB);
      expect(cp.source).toBe('sync');
      expect(cp.conflicted_files.some((f) => f.includes('shared.txt'))).toBe(true);
    } finally {
      tracker.close();
    }
  });

  it('emits cascade.rebased per dependent + cascade.completed with the walk summary', () => {
    const { emit, events } = createCapturingEmitter();
    const tracker = new MultiAgentRepoTracker({
      repoPath: testRepo.path,
      emit,
      skipRecovery: true,
    });

    try {
      const agentA = 'agent-alpha';
      const agentB = 'agent-beta';
      const worktreeA = path.join(testRepo.path, '.worktrees', agentA);
      const worktreeB = path.join(testRepo.path, '.worktrees', agentB);

      // Parent stream with an initial commit.
      const parentId = tracker.createStream({ name: 'parent', agentId: agentA });
      tracker.createWorktree({
        agentId: agentA,
        path: worktreeA,
        branch: `stream/${parentId}`,
      });
      fs.writeFileSync(path.join(worktreeA, 'base.txt'), 'base\n');
      execSync('git add .', { cwd: worktreeA, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: parentId,
        agentId: agentA,
        worktree: worktreeA,
        message: 'base: init',
      });

      // Child stream forked from parent with its own commit.
      const childId = tracker.forkStream({
        parentStreamId: parentId,
        name: 'child',
        agentId: agentB,
      });
      tracker.createWorktree({
        agentId: agentB,
        path: worktreeB,
        branch: `stream/${childId}`,
      });
      fs.writeFileSync(path.join(worktreeB, 'child.txt'), 'child work\n');
      execSync('git add .', { cwd: worktreeB, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: childId,
        agentId: agentB,
        worktree: worktreeB,
        message: 'feat: child work',
      });

      // Parent gains another commit so there's something for child to rebase onto.
      fs.writeFileSync(path.join(worktreeA, 'base.txt'), 'base v2\n');
      execSync('git add .', { cwd: worktreeA, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: parentId,
        agentId: agentA,
        worktree: worktreeA,
        message: 'base: v2',
      });

      events.length = 0;

      // Cascade rebase dependents of parent (i.e., child).
      const result = tracker.cascadeRebase({
        rootStream: parentId,
        agentId: agentA,
        worktree: { mode: 'callback', provider: () => worktreeB },
        strategy: 'stop_on_conflict',
      });

      expect(result.success).toBe(true);
      expect(result.updated).toEqual([childId]);

      // Exactly one cascade.rebased event.
      const rebased = events.filter(
        (e) => e.method === CASCADE_METHODS.CASCADE_REBASED
      );
      expect(rebased).toHaveLength(1);
      const rp = rebased[0].params as CascadeRebasedParams;
      expect(rp.stream_id).toBe(childId);
      expect(rp.agent_id).toBe(agentA);
      expect(rp.triggered_by_stream_id).toBe(parentId);
      expect(rp.new_commits.length).toBeGreaterThanOrEqual(1);
      // The child's original 'feat: child work' should show up as a new commit
      // in the rebased range.
      const summaries = rp.new_commits.map((c) => c.message_summary);
      expect(summaries.some((s) => s.includes('feat: child work'))).toBe(true);
      // Each rebased commit should carry a Change-Id trailer.
      expect(rp.new_commits.every((c) => typeof c.change_id === 'string' && c.change_id.length > 0)).toBe(true);

      // cascade.completed fires with the summary.
      const completed = events.find(
        (e) => e.method === CASCADE_METHODS.CASCADE_COMPLETED
      );
      expect(completed).toBeDefined();
      const cp = completed!.params as CascadeCompletedParams;
      expect(cp.root_stream_id).toBe(parentId);
      expect(cp.updated_streams).toEqual([childId]);
      expect(cp.failed_streams).toEqual([]);
      expect(cp.skipped_streams).toEqual([]);
    } finally {
      tracker.close();
    }
  });

  it('emits stream.merged with task-merge strategy when a worker task completes', () => {
    const { emit, events } = createCapturingEmitter();
    const tracker = new MultiAgentRepoTracker({
      repoPath: testRepo.path,
      emit,
      skipRecovery: true,
    });

    try {
      const agentA = 'agent-alpha';
      const workerPath = path.join(testRepo.path, '.worktrees', agentA);

      const streamId = tracker.createStream({ name: 'integration', agentId: agentA });
      tracker.createWorktree({ agentId: agentA, path: workerPath, branch: `stream/${streamId}` });

      // Need a commit on the stream so startTask has a valid start_commit base.
      fs.writeFileSync(path.join(workerPath, 'README.md'), 'hi\n');
      execSync('git add .', { cwd: workerPath, stdio: 'pipe' });
      tracker.commitChanges({
        streamId,
        agentId: agentA,
        worktree: workerPath,
        message: 'base: init README',
      });

      const taskId = tracker.createTask({
        streamId,
        title: 'Add a feature',
      });

      tracker.startTask({
        taskId,
        agentId: agentA,
        worktree: workerPath,
      });

      // Commit on the worker branch
      fs.writeFileSync(path.join(workerPath, 'feat.txt'), 'feat content\n');
      execSync('git add .', { cwd: workerPath, stdio: 'pipe' });
      execSync('git commit -m "feat: worker commit"', { cwd: workerPath, stdio: 'pipe' });

      events.length = 0;
      const result = tracker.completeTask({
        taskId,
        worktree: workerPath,
      });

      const merged = eventsOfType(events, CASCADE_METHODS.STREAM_MERGED);
      expect(merged).toHaveLength(1);
      const mp = merged[0].params as StreamMergedParams;
      expect(mp.merge_commit).toBe(result.mergeCommit);
      expect(mp.target_stream_id).toBe(streamId);
      expect(mp.strategy).toBe('task-merge');
      expect(mp.agent_id).toBe(agentA);
      expect(mp.metadata).toMatchObject({
        task_id: taskId,
        task_title: 'Add a feature',
      });
    } finally {
      tracker.close();
    }
  });
});
