/**
 * Worker Tasks E2E tests.
 *
 * Full end-to-end workflow tests for the worker tasks feature,
 * including integration with diff stacks and cherry-pick to main.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker } from '../../src/tracker.js';
import { createTestRepo, type TestRepo } from '../setup.js';
import * as git from '../../src/git/index.js';
import * as diffStacks from '../../src/diff-stacks.js';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

describe('Worker Tasks E2E', () => {
  let testRepo: TestRepo;
  let tracker: MultiAgentRepoTracker;

  beforeEach(() => {
    testRepo = createTestRepo();
    tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });
  });

  afterEach(() => {
    tracker.close();
    testRepo.cleanup();
  });

  // Helper to create a worktree for an agent on a specific stream
  // Uses --detach mode then checks out stream branch to avoid "already checked out" errors
  function createWorktree(agentId: string, streamId: string): string {
    const worktreePath = path.join(testRepo.path, '.worktrees', agentId);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    const streamBranch = `stream/${streamId}`;
    // Create worktree in detached state, then checkout the stream branch
    // This avoids "branch already checked out" errors
    execSync(`git worktree add --detach "${worktreePath}"`, {
      cwd: testRepo.path,
      stdio: 'pipe',
    });
    execSync(`git checkout ${streamBranch}`, {
      cwd: worktreePath,
      stdio: 'pipe',
    });
    return worktreePath;
  }

  // Helper to make a commit in a worktree
  function commitInWorktree(
    worktree: string,
    filename: string,
    content: string,
    message: string
  ): string {
    const filePath = path.join(worktree, filename);
    fs.writeFileSync(filePath, content);
    execSync('git add .', { cwd: worktree, stdio: 'pipe' });
    execSync(`git commit -m "${message}"`, { cwd: worktree, stdio: 'pipe' });
    return execSync('git rev-parse HEAD', { cwd: worktree, encoding: 'utf-8' }).trim();
  }

  describe('Full Workflow: Stream → Tasks → Diff Stack → Cherry-pick', () => {
    it('should complete full workflow with single agent', () => {
      // Step 1: Create an integration stream
      const streamId = tracker.createStream({
        name: 'feature-epic',
        agentId: 'agent-1',
      });

      // Step 2: Create multiple tasks
      const task1 = tracker.createTask({
        title: 'Implement authentication',
        streamId,
        priority: 10,
      });
      const task2 = tracker.createTask({
        title: 'Add user profile page',
        streamId,
        priority: 20,
      });

      // Verify tasks created
      const tasks = tracker.listTasks(streamId);
      expect(tasks).toHaveLength(2);

      // Step 3: Start and complete task1
      const worktree1 = createWorktree('agent-1', streamId);

      const start1 = tracker.startTask({
        taskId: task1,
        agentId: 'agent-1',
        worktree: worktree1,
      });
      expect(start1.branchName).toMatch(/^worker\/agent-1\//);

      // Make commits on worker branch
      commitInWorktree(worktree1, 'auth.ts', 'export function login() {}', 'Add login function');
      commitInWorktree(worktree1, 'auth.ts', 'export function logout() {}', 'Add logout function');

      const complete1 = tracker.completeTask({
        taskId: task1,
        worktree: worktree1,
        message: 'Merge: Implement authentication',
      });
      expect(complete1.mergeCommit).toBeDefined();

      // Step 4: Start and complete task2
      // Need new worktree since we're now on stream branch
      execSync(`git worktree remove "${worktree1}" --force`, {
        cwd: testRepo.path,
        stdio: 'pipe',
      });
      const worktree2 = createWorktree('agent-1', streamId);

      tracker.startTask({
        taskId: task2,
        agentId: 'agent-1',
        worktree: worktree2,
      });

      commitInWorktree(worktree2, 'profile.ts', 'export function getProfile() {}', 'Add profile page');

      const complete2 = tracker.completeTask({
        taskId: task2,
        worktree: worktree2,
        message: 'Merge: Add user profile page',
      });
      expect(complete2.mergeCommit).toBeDefined();

      // Verify both tasks completed
      expect(tracker.getTask(task1)!.status).toBe('completed');
      expect(tracker.getTask(task2)!.status).toBe('completed');

      // Step 5: Set up landing worktree first (needed before creating stack)
      execSync(`git worktree remove "${worktree2}" --force`, {
        cwd: testRepo.path,
        stdio: 'pipe',
      });
      const mainWorktree = path.join(testRepo.path, '.worktrees', 'main-landing');
      fs.mkdirSync(path.dirname(mainWorktree), { recursive: true });
      // Create a new branch from main for the landing worktree to avoid "main is already checked out"
      execSync(`git worktree add -b landing-main "${mainWorktree}" main`, {
        cwd: testRepo.path,
        stdio: 'pipe',
      });

      // Step 6: Create diff stack from stream (use landing-main as target since main is checked out)
      const stack = tracker.createStackFromStream({
        streamId,
        name: 'Feature Epic Release',
        targetBranch: 'landing-main',
      });

      expect(stack.name).toBe('Feature Epic Release');
      expect(stack.checkpoints.length).toBeGreaterThan(0);
      expect(stack.reviewStatus).toBe('pending');

      // Step 7: Approve stack
      diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack.id,
        status: 'approved',
        reviewedBy: 'reviewer-1',
      });

      // Step 8: Cherry-pick to landing-main
      const cherryPickResult = tracker.cherryPickStackToTarget(stack.id, mainWorktree);

      expect(cherryPickResult.success).toBe(true);
      expect(cherryPickResult.newCommits.length).toBeGreaterThan(0);

      // Verify stack marked as merged
      const updatedStack = diffStacks.getDiffStack(tracker.db, stack.id);
      expect(updatedStack!.reviewStatus).toBe('merged');

      // Verify commits are on landing-main (which can be fast-forward merged to main)
      const landingHead = git.getHead({ cwd: mainWorktree });
      expect(cherryPickResult.newCommits).toContain(landingHead);
    });

    it('should handle multiple agents working on different tasks', () => {
      // Create integration stream
      const streamId = tracker.createStream({
        name: 'multi-agent-feature',
        agentId: 'coordinator',
      });

      // Create tasks for different agents
      const task1 = tracker.createTask({ title: 'Agent 1 work', streamId });
      const task2 = tracker.createTask({ title: 'Agent 2 work', streamId });

      // Agent 1 starts their task
      const worktree1 = createWorktree('agent-1', streamId);
      tracker.startTask({
        taskId: task1,
        agentId: 'agent-1',
        worktree: worktree1,
      });

      // Agent 2 starts their task (different worktree)
      const worktree2 = createWorktree('agent-2', streamId);
      tracker.startTask({
        taskId: task2,
        agentId: 'agent-2',
        worktree: worktree2,
      });

      // Both agents make commits in parallel (non-conflicting files)
      commitInWorktree(worktree1, 'agent1.ts', 'agent 1 code', 'Agent 1 commit');
      commitInWorktree(worktree2, 'agent2.ts', 'agent 2 code', 'Agent 2 commit');

      // Agent 1 completes first
      const result1 = tracker.completeTask({
        taskId: task1,
        worktree: worktree1,
      });
      expect(result1.mergeCommit).toBeDefined();

      // Remove worktree1 to release the stream branch (completeTask leaves worktree on stream)
      execSync(`git worktree remove "${worktree1}" --force`, {
        cwd: testRepo.path,
        stdio: 'pipe',
      });

      // Agent 2 rebases their worker branch onto the updated stream
      // This is the realistic workflow - fetch latest stream changes, rebase worker branch
      const streamBranch = `stream/${streamId}`;

      // Fetch the latest stream ref and rebase worker branch onto it
      execSync(`git fetch . ${streamBranch}:refs/remotes/origin/${streamBranch}`, {
        cwd: worktree2,
        stdio: 'pipe',
      });
      execSync(`git rebase refs/remotes/origin/${streamBranch}`, {
        cwd: worktree2,
        stdio: 'pipe',
      });

      // Agent 2 completes their task
      const result2 = tracker.completeTask({
        taskId: task2,
        worktree: worktree2,
      });
      expect(result2.mergeCommit).toBeDefined();

      // Verify both tasks completed
      expect(tracker.getTask(task1)!.status).toBe('completed');
      expect(tracker.getTask(task2)!.status).toBe('completed');

      // Verify stream has both merges by checking commit messages in log
      const log = execSync(`git log --oneline ${streamBranch} -5`, {
        cwd: testRepo.path,
        encoding: 'utf-8',
      });
      expect(log).toContain('Merge task');
    });

    it('should preserve commit history through merge commits', () => {
      const streamId = tracker.createStream({
        name: 'history-preservation',
        agentId: 'agent-1',
      });

      const taskId = tracker.createTask({
        title: 'Feature with history',
        streamId,
      });

      const worktree = createWorktree('agent-1', streamId);

      tracker.startTask({
        taskId,
        agentId: 'agent-1',
        worktree,
      });

      // Make multiple commits
      const commit1 = commitInWorktree(worktree, 'file1.ts', 'content 1', 'First commit');
      const commit2 = commitInWorktree(worktree, 'file2.ts', 'content 2', 'Second commit');
      const commit3 = commitInWorktree(worktree, 'file3.ts', 'content 3', 'Third commit');

      tracker.completeTask({
        taskId,
        worktree,
      });

      // Verify all commits are in the stream's history
      const streamBranch = `stream/${streamId}`;
      const history = execSync(`git log --format=%H ${streamBranch}`, {
        cwd: testRepo.path,
        encoding: 'utf-8',
      });

      expect(history).toContain(commit1);
      expect(history).toContain(commit2);
      expect(history).toContain(commit3);

      // Verify merge commit has 2 parents (--no-ff)
      const mergeCommit = tracker.getTask(taskId)!.mergeCommit!;
      const parents = execSync(`git log -1 --format=%P ${mergeCommit}`, {
        cwd: testRepo.path,
        encoding: 'utf-8',
      }).trim();
      const parentCount = parents.split(' ').filter(Boolean).length;
      expect(parentCount).toBe(2);
    });
  });

  describe('Conflict Recovery Workflow', () => {
    it('should recover from task conflict and retry', () => {
      const streamId = tracker.createStream({
        name: 'conflict-recovery',
        agentId: 'agent-1',
      });

      const taskId = tracker.createTask({
        title: 'Conflicting task',
        streamId,
      });

      // Start task
      const worktree = createWorktree('agent-1', streamId);
      tracker.startTask({
        taskId,
        agentId: 'agent-1',
        worktree,
      });

      // Make a commit on the worker branch
      const conflictFile = path.join(worktree, 'conflict.txt');
      fs.writeFileSync(conflictFile, 'worker content');
      execSync('git add . && git commit -m "Worker change"', {
        cwd: worktree,
        stdio: 'pipe',
      });

      // Make a conflicting commit on the stream (via a temporary worktree)
      const streamWorktree = path.join(testRepo.path, '.worktrees', 'stream-temp');
      fs.mkdirSync(path.dirname(streamWorktree), { recursive: true });
      // Use --detach then checkout to avoid "branch already checked out" error
      execSync(`git worktree add --detach "${streamWorktree}"`, {
        cwd: testRepo.path,
        stdio: 'pipe',
      });
      execSync(`git checkout stream/${streamId}`, {
        cwd: streamWorktree,
        stdio: 'pipe',
      });
      fs.writeFileSync(path.join(streamWorktree, 'conflict.txt'), 'stream content');
      execSync('git add . && git commit -m "Stream change"', {
        cwd: streamWorktree,
        stdio: 'pipe',
      });
      execSync(`git worktree remove "${streamWorktree}" --force`, {
        cwd: testRepo.path,
        stdio: 'pipe',
      });

      // Try to complete - should fail with conflict
      let conflictError: Error | null = null;
      try {
        tracker.completeTask({
          taskId,
          worktree,
        });
      } catch (err) {
        conflictError = err as Error;
      }

      expect(conflictError).not.toBeNull();
      expect(conflictError!.name).toBe('TaskConflictError');

      // Task should be released back to open
      const task = tracker.getTask(taskId)!;
      expect(task.status).toBe('open');
      expect(task.agentId).toBeNull();
      // Branch should still exist for recovery
      expect(task.branchName).not.toBeNull();

      // Agent can restart the task (branch already exists)
      // First, resolve the conflict manually
      git.checkout(task.branchName!, { cwd: worktree });
      // Rebase onto stream
      try {
        execSync(`git rebase stream/${streamId}`, { cwd: worktree, stdio: 'pipe' });
      } catch {
        // Resolve conflict
        fs.writeFileSync(conflictFile, 'resolved content');
        execSync('git add . && git rebase --continue', { cwd: worktree, stdio: 'pipe' });
      }

      // Manually update task to in_progress again
      tracker.startTask({
        taskId,
        agentId: 'agent-1',
        worktree,
      });

      // Now complete should work
      const result = tracker.completeTask({
        taskId,
        worktree,
      });

      expect(result.mergeCommit).toBeDefined();
      expect(tracker.getTask(taskId)!.status).toBe('completed');
    });
  });

  describe('Task Priority and Ordering', () => {
    it('should process tasks in priority order', () => {
      const streamId = tracker.createStream({
        name: 'priority-stream',
        agentId: 'agent-1',
      });

      // Create tasks with different priorities (lower = higher priority)
      const lowPriority = tracker.createTask({
        title: 'Low priority',
        streamId,
        priority: 100,
      });
      const highPriority = tracker.createTask({
        title: 'High priority',
        streamId,
        priority: 10,
      });
      const mediumPriority = tracker.createTask({
        title: 'Medium priority',
        streamId,
        priority: 50,
      });

      // List should return in priority order
      const tasks = tracker.listTasks(streamId);
      expect(tasks[0].id).toBe(highPriority);
      expect(tasks[1].id).toBe(mediumPriority);
      expect(tasks[2].id).toBe(lowPriority);
    });
  });

  describe('Nested Stream Hierarchy with Tasks', () => {
    it('should manage tasks across nested streams', () => {
      // Create hierarchy: epic -> feature -> subtask-stream
      const epicId = tracker.createStream({
        name: 'epic',
        agentId: 'coordinator',
      });

      const featureId = tracker.forkStream({
        parentStreamId: epicId,
        name: 'feature',
        agentId: 'agent-1',
      });

      // Create tasks at different levels
      const epicTask = tracker.createTask({
        title: 'Epic coordination task',
        streamId: epicId,
      });
      const featureTask1 = tracker.createTask({
        title: 'Feature task 1',
        streamId: featureId,
      });
      const featureTask2 = tracker.createTask({
        title: 'Feature task 2',
        streamId: featureId,
      });

      // Get hierarchy and verify tasks at each level
      const hierarchy = tracker.getStreamHierarchy(epicId);
      expect(Array.isArray(hierarchy)).toBe(false);

      const epicNode = hierarchy as { stream: { id: string }; tasks: { id: string }[]; children: unknown[] };
      expect(epicNode.stream.id).toBe(epicId);
      expect(epicNode.tasks.map((t) => t.id)).toContain(epicTask);

      const featureNode = epicNode.children[0] as { stream: { id: string }; tasks: { id: string }[] };
      expect(featureNode.stream.id).toBe(featureId);
      expect(featureNode.tasks.map((t) => t.id)).toContain(featureTask1);
      expect(featureNode.tasks.map((t) => t.id)).toContain(featureTask2);
    });
  });

  describe('Cleanup and Recovery', () => {
    it('should cleanup old worker branches', () => {
      const streamId = tracker.createStream({
        name: 'cleanup-test',
        agentId: 'agent-1',
      });

      const taskId = tracker.createTask({
        title: 'Task to cleanup',
        streamId,
      });

      const worktree = createWorktree('agent-1', streamId);
      const { branchName } = tracker.startTask({
        taskId,
        agentId: 'agent-1',
        worktree,
      });

      // Complete the task
      commitInWorktree(worktree, 'file.ts', 'content', 'Add file');
      tracker.completeTask({ taskId, worktree });

      // Manually backdate the completion time
      const db = tracker.db;
      const oldTime = Date.now() - 48 * 60 * 60 * 1000; // 48 hours ago
      const tables = tracker.tables;
      db.prepare(`UPDATE ${tables.worker_tasks} SET completed_at = ? WHERE id = ?`).run(oldTime, taskId);

      // Remove worktree before cleanup
      execSync(`git worktree remove "${worktree}" --force`, {
        cwd: testRepo.path,
        stdio: 'pipe',
      });

      // Run cleanup
      const result = tracker.cleanupWorkerBranches({
        olderThanMs: 24 * 60 * 60 * 1000, // 24 hours
      });

      expect(result.deleted).toContain(branchName);
    });
  });
});
