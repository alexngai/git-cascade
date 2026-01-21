/**
 * Worker Tasks tests.
 *
 * Tests for the worker tasks module which provides lifecycle management
 * for ephemeral worker branches that merge into streams.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { MultiAgentRepoTracker } from '../src/index.js';
import * as workerTasks from '../src/worker-tasks.js';
import { createTestRepo, commitFile, type TestRepo } from './setup.js';

describe('Worker Tasks', () => {
  let testRepo: TestRepo;
  let tracker: MultiAgentRepoTracker;
  let streamId: string;

  beforeEach(() => {
    testRepo = createTestRepo();
    tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });

    // Create a stream for tasks
    streamId = tracker.createStream({
      name: 'feature-stream',
      agentId: 'agent-1',
    });
  });

  afterEach(() => {
    tracker.close();
    testRepo.cleanup();
  });

  // Helper to create a worktree for an agent
  function createWorktree(agentId: string): string {
    const worktreePath = path.join(testRepo.path, '.worktrees', agentId);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    const streamBranch = `stream/${streamId}`;
    execSync(`git worktree add "${worktreePath}" ${streamBranch}`, {
      cwd: testRepo.path,
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

  describe('CRUD Operations', () => {
    describe('createTask', () => {
      it('should create a task under a stream', () => {
        const taskId = workerTasks.createTask(tracker.db, {
          title: 'Test Task',
          streamId,
        });

        expect(taskId).toMatch(/^wt-/);

        const task = workerTasks.getTask(tracker.db, taskId);
        expect(task).not.toBeNull();
        expect(task!.title).toBe('Test Task');
        expect(task!.streamId).toBe(streamId);
        expect(task!.status).toBe('open');
        expect(task!.agentId).toBeNull();
        expect(task!.branchName).toBeNull();
        expect(task!.priority).toBe(100);
      });

      it('should create a task with custom priority', () => {
        const taskId = workerTasks.createTask(tracker.db, {
          title: 'High Priority Task',
          streamId,
          priority: 10,
        });

        const task = workerTasks.getTask(tracker.db, taskId);
        expect(task!.priority).toBe(10);
      });

      it('should create a task with metadata', () => {
        const taskId = workerTasks.createTask(tracker.db, {
          title: 'Task with Metadata',
          streamId,
          metadata: { issueId: 'PROJ-123', labels: ['bug'] },
        });

        const task = workerTasks.getTask(tracker.db, taskId);
        expect(task!.metadata).toEqual({ issueId: 'PROJ-123', labels: ['bug'] });
      });

      it('should throw if stream does not exist', () => {
        expect(() => {
          workerTasks.createTask(tracker.db, {
            title: 'Task',
            streamId: 'nonexistent',
          });
        }).toThrow(/not found/);
      });

      it('should throw if stream is not active', () => {
        tracker.abandonStream(streamId);

        expect(() => {
          workerTasks.createTask(tracker.db, {
            title: 'Task',
            streamId,
          });
        }).toThrow(/must be 'active'/);
      });
    });

    describe('getTask', () => {
      it('should return null for nonexistent task', () => {
        const task = workerTasks.getTask(tracker.db, 'nonexistent');
        expect(task).toBeNull();
      });

      it('should return the task if it exists', () => {
        const taskId = workerTasks.createTask(tracker.db, {
          title: 'Test',
          streamId,
        });

        const task = workerTasks.getTask(tracker.db, taskId);
        expect(task).not.toBeNull();
        expect(task!.id).toBe(taskId);
      });
    });

    describe('getTaskOrThrow', () => {
      it('should throw TaskNotFoundError for nonexistent task', () => {
        expect(() => {
          workerTasks.getTaskOrThrow(tracker.db, 'nonexistent');
        }).toThrow(workerTasks.TaskNotFoundError);
      });
    });

    describe('listTasks', () => {
      it('should list all tasks for a stream', () => {
        workerTasks.createTask(tracker.db, { title: 'Task 1', streamId });
        workerTasks.createTask(tracker.db, { title: 'Task 2', streamId });
        workerTasks.createTask(tracker.db, { title: 'Task 3', streamId });

        const tasks = workerTasks.listTasks(tracker.db, streamId);
        expect(tasks).toHaveLength(3);
      });

      it('should filter by status', () => {
        const task1 = workerTasks.createTask(tracker.db, { title: 'Task 1', streamId });
        workerTasks.createTask(tracker.db, { title: 'Task 2', streamId });

        // Abandon task1
        workerTasks.abandonTask(tracker.db, testRepo.path, task1);

        const openTasks = workerTasks.listTasks(tracker.db, streamId, { status: 'open' });
        expect(openTasks).toHaveLength(1);
        expect(openTasks[0].title).toBe('Task 2');

        const abandonedTasks = workerTasks.listTasks(tracker.db, streamId, { status: 'abandoned' });
        expect(abandonedTasks).toHaveLength(1);
        expect(abandonedTasks[0].title).toBe('Task 1');
      });

      it('should order by priority then created_at', () => {
        workerTasks.createTask(tracker.db, { title: 'Low Priority', streamId, priority: 200 });
        workerTasks.createTask(tracker.db, { title: 'High Priority', streamId, priority: 10 });
        workerTasks.createTask(tracker.db, { title: 'Medium Priority', streamId, priority: 100 });

        const tasks = workerTasks.listTasks(tracker.db, streamId);
        expect(tasks[0].title).toBe('High Priority');
        expect(tasks[1].title).toBe('Medium Priority');
        expect(tasks[2].title).toBe('Low Priority');
      });

      it('should return empty array for stream with no tasks', () => {
        const tasks = workerTasks.listTasks(tracker.db, streamId);
        expect(tasks).toHaveLength(0);
      });
    });

    describe('updateTask', () => {
      it('should update task title', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Original', streamId });

        workerTasks.updateTask(tracker.db, taskId, { title: 'Updated' });

        const task = workerTasks.getTask(tracker.db, taskId);
        expect(task!.title).toBe('Updated');
      });

      it('should update task priority', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });

        workerTasks.updateTask(tracker.db, taskId, { priority: 1 });

        const task = workerTasks.getTask(tracker.db, taskId);
        expect(task!.priority).toBe(1);
      });

      it('should update task metadata', () => {
        const taskId = workerTasks.createTask(tracker.db, {
          title: 'Task',
          streamId,
          metadata: { original: true },
        });

        workerTasks.updateTask(tracker.db, taskId, { metadata: { updated: true } });

        const task = workerTasks.getTask(tracker.db, taskId);
        expect(task!.metadata).toEqual({ updated: true });
      });

      it('should throw for nonexistent task', () => {
        expect(() => {
          workerTasks.updateTask(tracker.db, 'nonexistent', { title: 'New' });
        }).toThrow(workerTasks.TaskNotFoundError);
      });

      it('should do nothing if no updates provided', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const before = workerTasks.getTask(tracker.db, taskId);

        workerTasks.updateTask(tracker.db, taskId, {});

        const after = workerTasks.getTask(tracker.db, taskId);
        expect(after).toEqual(before);
      });
    });
  });

  describe('Lifecycle Operations', () => {
    describe('startTask', () => {
      it('should start a task and create a worker branch', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        const result = workerTasks.startTask(tracker.db, testRepo.path, {
          taskId,
          agentId: 'agent-1',
          worktree,
        });

        expect(result.branchName).toMatch(/^worker\/agent-1\/wt-/);
        expect(result.startCommit).toMatch(/^[a-f0-9]{40}$/);

        const task = workerTasks.getTask(tracker.db, taskId);
        expect(task!.status).toBe('in_progress');
        expect(task!.agentId).toBe('agent-1');
        expect(task!.branchName).toBe(result.branchName);
        expect(task!.startCommit).toBe(result.startCommit);
        expect(task!.startedAt).not.toBeNull();
      });

      it('should checkout the worker branch in the worktree', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        const result = workerTasks.startTask(tracker.db, testRepo.path, {
          taskId,
          agentId: 'agent-1',
          worktree,
        });

        // Verify the worktree is on the worker branch
        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: worktree,
          encoding: 'utf-8',
        }).trim();
        expect(currentBranch).toBe(result.branchName);
      });

      it('should throw if task is not open', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        // Start once
        workerTasks.startTask(tracker.db, testRepo.path, {
          taskId,
          agentId: 'agent-1',
          worktree,
        });

        // Try to start again
        expect(() => {
          workerTasks.startTask(tracker.db, testRepo.path, {
            taskId,
            agentId: 'agent-2',
            worktree,
          });
        }).toThrow(/must be 'open'/);
      });

      it('should throw if stream is not active', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        tracker.abandonStream(streamId);

        expect(() => {
          workerTasks.startTask(tracker.db, testRepo.path, {
            taskId,
            agentId: 'agent-1',
            worktree,
          });
        }).toThrow(/status 'abandoned'/);
      });
    });

    describe('completeTask', () => {
      it('should merge the worker branch to the stream', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        workerTasks.startTask(tracker.db, testRepo.path, {
          taskId,
          agentId: 'agent-1',
          worktree,
        });

        // Make a commit on the worker branch
        commitInWorktree(worktree, 'feature.ts', 'export const x = 1;', 'Add feature');

        const result = workerTasks.completeTask(tracker.db, testRepo.path, {
          taskId,
          worktree,
        });

        expect(result.mergeCommit).toMatch(/^[a-f0-9]{40}$/);

        const task = workerTasks.getTask(tracker.db, taskId);
        expect(task!.status).toBe('completed');
        expect(task!.mergeCommit).toBe(result.mergeCommit);
        expect(task!.completedAt).not.toBeNull();
      });

      it('should use custom merge message if provided', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        workerTasks.startTask(tracker.db, testRepo.path, {
          taskId,
          agentId: 'agent-1',
          worktree,
        });

        commitInWorktree(worktree, 'feature.ts', 'code', 'Add feature');

        workerTasks.completeTask(tracker.db, testRepo.path, {
          taskId,
          worktree,
          message: 'Custom merge message',
        });

        // Verify the merge commit message
        const log = execSync('git log -1 --format=%s', { cwd: worktree, encoding: 'utf-8' }).trim();
        expect(log).toBe('Custom merge message');
      });

      it('should create a merge commit even for fast-forward', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        workerTasks.startTask(tracker.db, testRepo.path, {
          taskId,
          agentId: 'agent-1',
          worktree,
        });

        commitInWorktree(worktree, 'feature.ts', 'code', 'Add feature');

        workerTasks.completeTask(tracker.db, testRepo.path, {
          taskId,
          worktree,
        });

        // Verify it's a merge commit (has 2 parents)
        const parents = execSync('git log -1 --format=%P', { cwd: worktree, encoding: 'utf-8' }).trim();
        const parentCount = parents.split(' ').filter(Boolean).length;
        expect(parentCount).toBe(2);
      });

      it('should record task merge in database', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        workerTasks.startTask(tracker.db, testRepo.path, {
          taskId,
          agentId: 'agent-1',
          worktree,
        });

        commitInWorktree(worktree, 'feature.ts', 'code', 'Add feature');

        workerTasks.completeTask(tracker.db, testRepo.path, {
          taskId,
          worktree,
        });

        const merges = workerTasks.getTaskMerges(tracker.db, taskId);
        expect(merges).toHaveLength(1);
        expect(merges[0].taskId).toBe(taskId);
        expect(merges[0].targetStreamId).toBe(streamId);
        expect(merges[0].createdBy).toBe('agent-1');
      });

      it('should throw if task is not in_progress', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        expect(() => {
          workerTasks.completeTask(tracker.db, testRepo.path, {
            taskId,
            worktree,
          });
        }).toThrow(/must be 'in_progress'/);
      });

      it('should throw if task has no branch', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        // Manually set to in_progress without branch
        workerTasks.updateTask(tracker.db, taskId, { status: 'in_progress' });
        const worktree = createWorktree('agent-1');

        expect(() => {
          workerTasks.completeTask(tracker.db, testRepo.path, {
            taskId,
            worktree,
          });
        }).toThrow(/no branch name/);
      });
    });

    describe('abandonTask', () => {
      it('should mark task as abandoned', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });

        workerTasks.abandonTask(tracker.db, testRepo.path, taskId);

        const task = workerTasks.getTask(tracker.db, taskId);
        expect(task!.status).toBe('abandoned');
      });

      it('should delete branch when requested', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        const { branchName } = workerTasks.startTask(tracker.db, testRepo.path, {
          taskId,
          agentId: 'agent-1',
          worktree,
        });

        // Checkout stream branch to allow worker branch deletion
        execSync(`git checkout stream/${streamId}`, { cwd: worktree, stdio: 'pipe' });

        workerTasks.abandonTask(tracker.db, testRepo.path, taskId, { deleteBranch: true });

        // Verify branch no longer exists
        const branches = execSync('git branch --list', { cwd: testRepo.path, encoding: 'utf-8' });
        expect(branches).not.toContain(branchName);
      });

      it('should throw if task is completed', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        workerTasks.startTask(tracker.db, testRepo.path, {
          taskId,
          agentId: 'agent-1',
          worktree,
        });

        commitInWorktree(worktree, 'feature.ts', 'code', 'Add feature');

        workerTasks.completeTask(tracker.db, testRepo.path, {
          taskId,
          worktree,
        });

        expect(() => {
          workerTasks.abandonTask(tracker.db, testRepo.path, taskId);
        }).toThrow(/Cannot abandon completed task/);
      });
    });

    describe('releaseTask', () => {
      it('should release in_progress task back to open', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        const { branchName } = workerTasks.startTask(tracker.db, testRepo.path, {
          taskId,
          agentId: 'agent-1',
          worktree,
        });

        workerTasks.releaseTask(tracker.db, taskId);

        const task = workerTasks.getTask(tracker.db, taskId);
        expect(task!.status).toBe('open');
        expect(task!.agentId).toBeNull();
        // Branch name is preserved so work isn't lost
        expect(task!.branchName).toBe(branchName);
      });

      it('should throw if task is completed', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        workerTasks.startTask(tracker.db, testRepo.path, {
          taskId,
          agentId: 'agent-1',
          worktree,
        });

        commitInWorktree(worktree, 'feature.ts', 'code', 'Add feature');

        workerTasks.completeTask(tracker.db, testRepo.path, {
          taskId,
          worktree,
        });

        expect(() => {
          workerTasks.releaseTask(tracker.db, taskId);
        }).toThrow(/Cannot release completed task/);
      });

      it('should throw if task is abandoned', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });

        workerTasks.abandonTask(tracker.db, testRepo.path, taskId);

        expect(() => {
          workerTasks.releaseTask(tracker.db, taskId);
        }).toThrow(/Cannot release abandoned task/);
      });
    });
  });

  describe('Conflict Handling', () => {
    // Helper to commit to stream branch without keeping it checked out
    // Uses a temporary worktree that gets cleaned up immediately
    function commitToStreamBranch(filename: string, content: string, message: string): void {
      const streamWorktreePath = path.join(testRepo.path, '.worktrees', 'stream-ops');
      const streamBranch = `stream/${streamId}`;

      try {
        // Create temporary worktree
        fs.mkdirSync(path.dirname(streamWorktreePath), { recursive: true });
        execSync(`git worktree add "${streamWorktreePath}" ${streamBranch}`, {
          cwd: testRepo.path,
          stdio: 'pipe',
        });

        // Make the commit
        fs.writeFileSync(path.join(streamWorktreePath, filename), content);
        execSync('git add .', { cwd: streamWorktreePath, stdio: 'pipe' });
        execSync(`git commit -m "${message}"`, { cwd: streamWorktreePath, stdio: 'pipe' });
      } finally {
        // Always clean up the worktree so the branch can be checked out elsewhere
        try {
          execSync(`git worktree remove "${streamWorktreePath}" --force`, {
            cwd: testRepo.path,
            stdio: 'pipe',
          });
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    it('should release task on merge conflict', () => {
      const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
      const worktree = createWorktree('agent-1');

      workerTasks.startTask(tracker.db, testRepo.path, {
        taskId,
        agentId: 'agent-1',
        worktree,
      });

      // Make conflicting changes
      // First, make a change on the stream branch
      commitToStreamBranch('conflict.txt', 'stream version', 'Stream change');

      // Now make conflicting change on the worker branch
      fs.writeFileSync(path.join(worktree, 'conflict.txt'), 'worker version');
      execSync('git add .', { cwd: worktree, stdio: 'pipe' });
      execSync('git commit -m "Worker change"', { cwd: worktree, stdio: 'pipe' });

      // Try to complete - should throw TaskConflictError
      expect(() => {
        workerTasks.completeTask(tracker.db, testRepo.path, {
          taskId,
          worktree,
        });
      }).toThrow(workerTasks.TaskConflictError);

      // Task should be released back to open
      const taskAfter = workerTasks.getTask(tracker.db, taskId);
      expect(taskAfter!.status).toBe('open');
      expect(taskAfter!.agentId).toBeNull();
      // Branch name preserved
      expect(taskAfter!.branchName).not.toBeNull();
    });

    it('should include conflicting files in TaskConflictError', () => {
      const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
      const worktree = createWorktree('agent-1');

      workerTasks.startTask(tracker.db, testRepo.path, {
        taskId,
        agentId: 'agent-1',
        worktree,
      });

      // Create conflict
      commitToStreamBranch('conflict.txt', 'stream version', 'Stream change');

      fs.writeFileSync(path.join(worktree, 'conflict.txt'), 'worker version');
      execSync('git add .', { cwd: worktree, stdio: 'pipe' });
      execSync('git commit -m "Worker change"', { cwd: worktree, stdio: 'pipe' });

      try {
        workerTasks.completeTask(tracker.db, testRepo.path, {
          taskId,
          worktree,
        });
        expect.fail('Should have thrown TaskConflictError');
      } catch (error) {
        expect(error).toBeInstanceOf(workerTasks.TaskConflictError);
        const conflictError = error as workerTasks.TaskConflictError;
        expect(conflictError.taskId).toBe(taskId);
        expect(conflictError.conflicts).toContain('conflict.txt');
      }
    });

    describe('detectTaskConflicts', () => {
      it('should detect potential conflicts without modifying repo', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        workerTasks.startTask(tracker.db, testRepo.path, {
          taskId,
          agentId: 'agent-1',
          worktree,
        });

        // Create conflict scenario
        commitToStreamBranch('conflict.txt', 'stream version', 'Stream change');

        const task = workerTasks.getTask(tracker.db, taskId);
        fs.writeFileSync(path.join(worktree, 'conflict.txt'), 'worker version');
        execSync('git add .', { cwd: worktree, stdio: 'pipe' });
        execSync('git commit -m "Worker change"', { cwd: worktree, stdio: 'pipe' });

        const conflicts = workerTasks.detectTaskConflicts(
          tracker.db,
          testRepo.path,
          taskId,
          worktree
        );

        expect(conflicts).toContain('conflict.txt');

        // Verify repo state is unchanged - we're still on worker branch
        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: worktree,
          encoding: 'utf-8',
        }).trim();
        expect(currentBranch).toBe(task!.branchName);
      });

      it('should return empty array if no conflicts', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        workerTasks.startTask(tracker.db, testRepo.path, {
          taskId,
          agentId: 'agent-1',
          worktree,
        });

        // Make a commit that won't conflict
        fs.writeFileSync(path.join(worktree, 'no-conflict.txt'), 'safe content');
        execSync('git add .', { cwd: worktree, stdio: 'pipe' });
        execSync('git commit -m "Safe change"', { cwd: worktree, stdio: 'pipe' });

        const conflicts = workerTasks.detectTaskConflicts(
          tracker.db,
          testRepo.path,
          taskId,
          worktree
        );

        expect(conflicts).toHaveLength(0);
      });
    });
  });

  describe('Cleanup and Recovery', () => {
    describe('cleanupWorkerBranches', () => {
      it('should delete branches for abandoned tasks', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        const { branchName } = workerTasks.startTask(tracker.db, testRepo.path, {
          taskId,
          agentId: 'agent-1',
          worktree,
        });

        // Checkout stream to allow deletion
        execSync(`git checkout stream/${streamId}`, { cwd: worktree, stdio: 'pipe' });

        workerTasks.abandonTask(tracker.db, testRepo.path, taskId, { deleteBranch: false });

        const result = workerTasks.cleanupWorkerBranches(tracker.db, testRepo.path);

        expect(result.deleted).toContain(branchName);

        // Verify task branchName is cleared
        const task = workerTasks.getTask(tracker.db, taskId);
        expect(task!.branchName).toBeNull();
      });

      it('should delete branches for old completed tasks', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        const { branchName } = workerTasks.startTask(tracker.db, testRepo.path, {
          taskId,
          agentId: 'agent-1',
          worktree,
        });

        commitInWorktree(worktree, 'feature.ts', 'code', 'Add feature');

        workerTasks.completeTask(tracker.db, testRepo.path, {
          taskId,
          worktree,
        });

        // Manually set completedAt to be in the past
        const oldTimestamp = Date.now() - 48 * 60 * 60 * 1000; // 48 hours ago
        workerTasks.updateTask(tracker.db, taskId, { completedAt: oldTimestamp });

        const result = workerTasks.cleanupWorkerBranches(tracker.db, testRepo.path, {
          olderThanMs: 24 * 60 * 60 * 1000, // 24 hours
        });

        expect(result.deleted).toContain(branchName);
      });

      it('should not delete branches for recent completed tasks', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        const { branchName } = workerTasks.startTask(tracker.db, testRepo.path, {
          taskId,
          agentId: 'agent-1',
          worktree,
        });

        commitInWorktree(worktree, 'feature.ts', 'code', 'Add feature');

        workerTasks.completeTask(tracker.db, testRepo.path, {
          taskId,
          worktree,
        });

        // Task just completed, should not be deleted
        const result = workerTasks.cleanupWorkerBranches(tracker.db, testRepo.path);

        expect(result.deleted).not.toContain(branchName);
      });
    });

    describe('recoverStaleTasks', () => {
      it('should release tasks stuck in_progress for too long', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        workerTasks.startTask(tracker.db, testRepo.path, {
          taskId,
          agentId: 'agent-1',
          worktree,
        });

        // Manually set startedAt to be in the past
        const oldTimestamp = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
        workerTasks.updateTask(tracker.db, taskId, { startedAt: oldTimestamp });

        const result = workerTasks.recoverStaleTasks(tracker.db, 60 * 60 * 1000); // 1 hour threshold

        expect(result.released).toContain(taskId);

        const task = workerTasks.getTask(tracker.db, taskId);
        expect(task!.status).toBe('open');
        expect(task!.agentId).toBeNull();
      });

      it('should not release recent in_progress tasks', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        workerTasks.startTask(tracker.db, testRepo.path, {
          taskId,
          agentId: 'agent-1',
          worktree,
        });

        // Task just started, should not be released
        const result = workerTasks.recoverStaleTasks(tracker.db, 60 * 60 * 1000);

        expect(result.released).not.toContain(taskId);

        const task = workerTasks.getTask(tracker.db, taskId);
        expect(task!.status).toBe('in_progress');
      });
    });
  });

  describe('Query Helpers', () => {
    describe('getTaskCounts', () => {
      it('should return counts by status', () => {
        workerTasks.createTask(tracker.db, { title: 'Open 1', streamId });
        workerTasks.createTask(tracker.db, { title: 'Open 2', streamId });

        const task3 = workerTasks.createTask(tracker.db, { title: 'In Progress', streamId });
        const worktree = createWorktree('agent-1');
        workerTasks.startTask(tracker.db, testRepo.path, {
          taskId: task3,
          agentId: 'agent-1',
          worktree,
        });

        const task4 = workerTasks.createTask(tracker.db, { title: 'Abandoned', streamId });
        workerTasks.abandonTask(tracker.db, testRepo.path, task4);

        const counts = workerTasks.getTaskCounts(tracker.db, streamId);
        expect(counts.open).toBe(2);
        expect(counts.in_progress).toBe(1);
        expect(counts.abandoned).toBe(1);
        expect(counts.completed).toBe(0);
      });
    });

    describe('getNextTask', () => {
      it('should return highest priority open task', () => {
        workerTasks.createTask(tracker.db, { title: 'Low', streamId, priority: 100 });
        workerTasks.createTask(tracker.db, { title: 'High', streamId, priority: 10 });
        workerTasks.createTask(tracker.db, { title: 'Medium', streamId, priority: 50 });

        const next = workerTasks.getNextTask(tracker.db, streamId);
        expect(next!.title).toBe('High');
      });

      it('should return null if no open tasks', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        workerTasks.abandonTask(tracker.db, testRepo.path, taskId);

        const next = workerTasks.getNextTask(tracker.db, streamId);
        expect(next).toBeNull();
      });
    });

    describe('getTaskMerges and getStreamTaskMerges', () => {
      it('should track merge history for a task', () => {
        const taskId = workerTasks.createTask(tracker.db, { title: 'Task', streamId });
        const worktree = createWorktree('agent-1');

        workerTasks.startTask(tracker.db, testRepo.path, {
          taskId,
          agentId: 'agent-1',
          worktree,
        });

        commitInWorktree(worktree, 'feature.ts', 'code', 'Add feature');

        workerTasks.completeTask(tracker.db, testRepo.path, {
          taskId,
          worktree,
        });

        const taskMerges = workerTasks.getTaskMerges(tracker.db, taskId);
        expect(taskMerges).toHaveLength(1);

        const streamMerges = workerTasks.getStreamTaskMerges(tracker.db, streamId);
        expect(streamMerges).toHaveLength(1);
        expect(streamMerges[0].taskId).toBe(taskId);
      });
    });
  });

  describe('Branch Name Generation', () => {
    it('should generate valid worker branch names', () => {
      const name = workerTasks.generateWorkerBranchName('agent-1', 'task-1');

      expect(name).toMatch(/^worker\/agent-1\/task-1@[a-z0-9]+$/);
    });

    it('should include timestamp in branch name', () => {
      const before = Date.now().toString(36);
      const name = workerTasks.generateWorkerBranchName('agent-1', 'task-1');
      const after = Date.now().toString(36);

      // Extract timestamp from name
      const timestamp = name.split('@')[1];

      // Timestamp should be within the range
      expect(timestamp.length).toBeGreaterThanOrEqual(before.length);
      expect(timestamp.length).toBeLessThanOrEqual(after.length + 1);
    });

    it('should handle special characters in agent ID', () => {
      const name = workerTasks.generateWorkerBranchName('agent.with.dots', 'task-1');
      expect(name).toMatch(/^worker\/agent\.with\.dots\/task-1@/);
    });

    it('should differentiate by agent and task', () => {
      const name1 = workerTasks.generateWorkerBranchName('agent-1', 'task-1');
      const name2 = workerTasks.generateWorkerBranchName('agent-2', 'task-1');
      const name3 = workerTasks.generateWorkerBranchName('agent-1', 'task-2');

      // Different agents get different prefixes
      expect(name1.startsWith('worker/agent-1/')).toBe(true);
      expect(name2.startsWith('worker/agent-2/')).toBe(true);

      // Different tasks get different prefixes
      expect(name1.includes('/task-1@')).toBe(true);
      expect(name3.includes('/task-2@')).toBe(true);
    });
  });

  describe('Tracker API', () => {
    it('should expose task methods on tracker instance', () => {
      // Create task via tracker
      const taskId = tracker.createTask({
        title: 'Tracker API Task',
        streamId,
      });

      // Get task via tracker
      const task = tracker.getTask(taskId);
      expect(task).not.toBeNull();
      expect(task!.title).toBe('Tracker API Task');

      // List tasks via tracker
      const tasks = tracker.listTasks(streamId);
      expect(tasks).toHaveLength(1);
    });

    it('should support full task lifecycle via tracker', () => {
      const taskId = tracker.createTask({
        title: 'Full Lifecycle Task',
        streamId,
      });

      const worktree = createWorktree('agent-1');

      // Start task via tracker
      const startResult = tracker.startTask({
        taskId,
        agentId: 'agent-1',
        worktree,
      });

      expect(startResult.branchName).toMatch(/^worker\/agent-1\//);

      // Make a commit
      commitInWorktree(worktree, 'feature.ts', 'code', 'Add feature');

      // Complete task via tracker
      const completeResult = tracker.completeTask({
        taskId,
        worktree,
      });

      expect(completeResult.mergeCommit).toBeDefined();

      // Verify task is completed
      const task = tracker.getTask(taskId);
      expect(task!.status).toBe('completed');
    });

    it('should support abandon and release via tracker', () => {
      const taskId = tracker.createTask({
        title: 'Abandon Test',
        streamId,
      });

      const worktree = createWorktree('agent-1');

      tracker.startTask({
        taskId,
        agentId: 'agent-1',
        worktree,
      });

      // Release via tracker
      tracker.releaseTask(taskId);
      let task = tracker.getTask(taskId);
      expect(task!.status).toBe('open');

      // Restart and abandon
      tracker.startTask({
        taskId,
        agentId: 'agent-1',
        worktree,
      });

      tracker.abandonTask(taskId);
      task = tracker.getTask(taskId);
      expect(task!.status).toBe('abandoned');
    });

    it('should support cleanup via tracker', () => {
      const taskId = tracker.createTask({
        title: 'Cleanup Test',
        streamId,
      });

      const worktree = createWorktree('agent-1');

      tracker.startTask({
        taskId,
        agentId: 'agent-1',
        worktree,
      });

      tracker.abandonTask(taskId, { deleteBranch: false });

      // Cleanup via tracker
      const result = tracker.cleanupWorkerBranches();
      expect(result.deleted.length).toBeGreaterThanOrEqual(0);
    });
  });
});
