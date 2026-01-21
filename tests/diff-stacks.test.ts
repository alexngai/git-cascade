/**
 * Diff Stack CRUD tests.
 *
 * Tests for the unified diff stack system (s-366r).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker } from '../src/tracker.js';
import { createTestRepo } from './setup.js';
import * as checkpoints from '../src/checkpoints.js';
import * as diffStacks from '../src/diff-stacks.js';
import * as git from '../src/git/index.js';
import * as fs from 'fs';
import * as path from 'path';

describe('Diff Stack Operations', () => {
  let tracker: MultiAgentRepoTracker;
  let testRepo: ReturnType<typeof createTestRepo>;
  let streamId: string;

  beforeEach(() => {
    testRepo = createTestRepo();
    tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });

    // Create a stream for tests
    streamId = tracker.createStream({
      name: 'test-stream',
      agentId: 'agent-1',
    });
  });

  afterEach(() => {
    tracker.close();
    testRepo.cleanup();
  });

  // Helper to create a commit
  function makeCommit(message: string): string {
    const worktreePath = testRepo.path;
    const filePath = path.join(worktreePath, `file-${Date.now()}.txt`);
    fs.writeFileSync(filePath, `content for ${message}`);
    git.stageAll({ cwd: worktreePath });
    return git.commit(message, { cwd: worktreePath });
  }

  // Helper to create a checkpoint
  function createCheckpoint(commitSha: string): ReturnType<typeof checkpoints.createCheckpoint> {
    return checkpoints.createCheckpoint(tracker.db, {
      streamId,
      commitSha,
    });
  }

  describe('createDiffStack', () => {
    it('should create an empty stack with defaults', () => {
      const stack = diffStacks.createDiffStack(tracker.db);

      expect(stack.id).toMatch(/^ds-/);
      expect(stack.name).toBeNull();
      expect(stack.description).toBeNull();
      expect(stack.targetBranch).toBe('main');
      expect(stack.reviewStatus).toBe('pending');
      expect(stack.reviewedBy).toBeNull();
      expect(stack.reviewedAt).toBeNull();
      expect(stack.queuePosition).toBeNull();
      expect(stack.createdAt).toBeGreaterThan(0);
    });

    it('should create a stack with all options', () => {
      const stack = diffStacks.createDiffStack(tracker.db, {
        name: 'My Stack',
        description: 'Stack description',
        targetBranch: 'develop',
        createdBy: 'agent-1',
      });

      expect(stack.name).toBe('My Stack');
      expect(stack.description).toBe('Stack description');
      expect(stack.targetBranch).toBe('develop');
      expect(stack.createdBy).toBe('agent-1');
    });

    it('should create a stack with initial checkpoints', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');

      const cp1 = createCheckpoint(commit1);
      const cp2 = createCheckpoint(commit2);

      const stack = diffStacks.createDiffStack(tracker.db, {
        name: 'With Checkpoints',
        checkpointIds: [cp1.id, cp2.id],
      });

      const stackWithCps = diffStacks.getDiffStackWithCheckpoints(
        tracker.db,
        stack.id
      );
      expect(stackWithCps).not.toBeNull();
      expect(stackWithCps!.checkpoints).toHaveLength(2);
      expect(stackWithCps!.checkpoints[0].id).toBe(cp1.id);
      expect(stackWithCps!.checkpoints[1].id).toBe(cp2.id);
    });
  });

  describe('getDiffStack', () => {
    it('should get a stack by ID', () => {
      const created = diffStacks.createDiffStack(tracker.db, {
        name: 'Test Stack',
      });

      const retrieved = diffStacks.getDiffStack(tracker.db, created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.name).toBe('Test Stack');
    });

    it('should return null for non-existent ID', () => {
      const result = diffStacks.getDiffStack(tracker.db, 'ds-nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('addCheckpointToStack', () => {
    it('should add a checkpoint to a stack', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit = makeCommit('Test commit');
      const cp = createCheckpoint(commit);
      const stack = diffStacks.createDiffStack(tracker.db);

      const entry = diffStacks.addCheckpointToStack(tracker.db, {
        stackId: stack.id,
        checkpointId: cp.id,
      });

      expect(entry.id).toMatch(/^dse-/);
      expect(entry.stackId).toBe(stack.id);
      expect(entry.checkpointId).toBe(cp.id);
      expect(entry.position).toBe(0);
    });

    it('should auto-increment position', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');
      const cp1 = createCheckpoint(commit1);
      const cp2 = createCheckpoint(commit2);
      const stack = diffStacks.createDiffStack(tracker.db);

      diffStacks.addCheckpointToStack(tracker.db, {
        stackId: stack.id,
        checkpointId: cp1.id,
      });
      const entry2 = diffStacks.addCheckpointToStack(tracker.db, {
        stackId: stack.id,
        checkpointId: cp2.id,
      });

      expect(entry2.position).toBe(1);
    });

    it('should insert at specific position and shift others', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');
      const commit3 = makeCommit('Commit 3');
      const cp1 = createCheckpoint(commit1);
      const cp2 = createCheckpoint(commit2);
      const cp3 = createCheckpoint(commit3);
      const stack = diffStacks.createDiffStack(tracker.db);

      diffStacks.addCheckpointToStack(tracker.db, {
        stackId: stack.id,
        checkpointId: cp1.id,
      });
      diffStacks.addCheckpointToStack(tracker.db, {
        stackId: stack.id,
        checkpointId: cp2.id,
      });
      // Insert cp3 at position 1
      diffStacks.addCheckpointToStack(tracker.db, {
        stackId: stack.id,
        checkpointId: cp3.id,
        position: 1,
      });

      const cps = diffStacks.getCheckpointsInStack(tracker.db, stack.id);
      expect(cps).toHaveLength(3);
      expect(cps[0].id).toBe(cp1.id);
      expect(cps[1].id).toBe(cp3.id);
      expect(cps[2].id).toBe(cp2.id);
    });

    it('should throw if checkpoint does not exist', () => {
      const stack = diffStacks.createDiffStack(tracker.db);

      expect(() => {
        diffStacks.addCheckpointToStack(tracker.db, {
          stackId: stack.id,
          checkpointId: 'cp-nonexistent',
        });
      }).toThrow('Checkpoint not found');
    });

    it('should throw if stack does not exist', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit = makeCommit('Test commit');
      const cp = createCheckpoint(commit);

      expect(() => {
        diffStacks.addCheckpointToStack(tracker.db, {
          stackId: 'ds-nonexistent',
          checkpointId: cp.id,
        });
      }).toThrow('Stack not found');
    });
  });

  describe('getCheckpointsInStack', () => {
    it('should return checkpoints ordered by position', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');
      const commit3 = makeCommit('Commit 3');

      const cp1 = createCheckpoint(commit1);
      const cp2 = createCheckpoint(commit2);
      const cp3 = createCheckpoint(commit3);

      const stack = diffStacks.createDiffStack(tracker.db, {
        checkpointIds: [cp1.id, cp2.id, cp3.id],
      });

      const cps = diffStacks.getCheckpointsInStack(tracker.db, stack.id);

      expect(cps).toHaveLength(3);
      expect(cps[0].id).toBe(cp1.id);
      expect(cps[0].position).toBe(0);
      expect(cps[1].id).toBe(cp2.id);
      expect(cps[1].position).toBe(1);
      expect(cps[2].id).toBe(cp3.id);
      expect(cps[2].position).toBe(2);
    });

    it('should return empty array for stack with no checkpoints', () => {
      const stack = diffStacks.createDiffStack(tracker.db);
      const cps = diffStacks.getCheckpointsInStack(tracker.db, stack.id);
      expect(cps).toHaveLength(0);
    });
  });

  describe('getStacksForCheckpoint', () => {
    it('should return all stacks containing a checkpoint', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit = makeCommit('Test commit');
      const cp = createCheckpoint(commit);

      const stack1 = diffStacks.createDiffStack(tracker.db, {
        name: 'Stack 1',
        checkpointIds: [cp.id],
      });
      const stack2 = diffStacks.createDiffStack(tracker.db, {
        name: 'Stack 2',
        checkpointIds: [cp.id],
      });

      const stacks = diffStacks.getStacksForCheckpoint(tracker.db, cp.id);

      expect(stacks).toHaveLength(2);
      const ids = stacks.map((s) => s.id);
      expect(ids).toContain(stack1.id);
      expect(ids).toContain(stack2.id);
    });
  });

  describe('listDiffStacks', () => {
    it('should list all stacks', () => {
      diffStacks.createDiffStack(tracker.db, { name: 'Stack 1' });
      diffStacks.createDiffStack(tracker.db, { name: 'Stack 2' });

      const stacks = diffStacks.listDiffStacks(tracker.db);

      expect(stacks).toHaveLength(2);
    });

    it('should filter by target branch', () => {
      diffStacks.createDiffStack(tracker.db, {
        name: 'Main Stack',
        targetBranch: 'main',
      });
      diffStacks.createDiffStack(tracker.db, {
        name: 'Develop Stack',
        targetBranch: 'develop',
      });

      const stacks = diffStacks.listDiffStacks(tracker.db, {
        targetBranch: 'develop',
      });

      expect(stacks).toHaveLength(1);
      expect(stacks[0].name).toBe('Develop Stack');
    });

    it('should filter by review status', () => {
      const stack1 = diffStacks.createDiffStack(tracker.db, { name: 'Stack 1' });
      diffStacks.createDiffStack(tracker.db, { name: 'Stack 2' });

      diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack1.id,
        status: 'approved',
        reviewedBy: 'reviewer-1',
      });

      const stacks = diffStacks.listDiffStacks(tracker.db, {
        reviewStatus: 'approved',
      });

      expect(stacks).toHaveLength(1);
      expect(stacks[0].id).toBe(stack1.id);
    });
  });

  describe('setStackReviewStatus', () => {
    it('should update review status', () => {
      const stack = diffStacks.createDiffStack(tracker.db);

      const updated = diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack.id,
        status: 'approved',
        reviewedBy: 'reviewer-1',
        notes: 'Looks good!',
      });

      expect(updated).not.toBeNull();
      expect(updated!.reviewStatus).toBe('approved');
      expect(updated!.reviewedBy).toBe('reviewer-1');
      expect(updated!.reviewedAt).toBeGreaterThan(0);
      expect(updated!.reviewNotes).toBe('Looks good!');
    });

    it('should return null for non-existent stack', () => {
      const result = diffStacks.setStackReviewStatus(tracker.db, {
        stackId: 'ds-nonexistent',
        status: 'approved',
      });
      expect(result).toBeNull();
    });

    it('should throw error for invalid status transition from merged', () => {
      const stack = diffStacks.createDiffStack(tracker.db);

      // Approve then merge
      diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack.id,
        status: 'approved',
      });
      diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack.id,
        status: 'merged',
      });

      // Cannot change from merged
      expect(() => {
        diffStacks.setStackReviewStatus(tracker.db, {
          stackId: stack.id,
          status: 'pending',
        });
      }).toThrow('Invalid status transition');
    });

    it('should allow valid status transitions', () => {
      const stack = diffStacks.createDiffStack(tracker.db);

      // pending -> rejected
      diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack.id,
        status: 'rejected',
      });

      // rejected -> pending
      diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack.id,
        status: 'pending',
      });

      // pending -> approved
      diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack.id,
        status: 'approved',
      });

      const result = diffStacks.getDiffStack(tracker.db, stack.id);
      expect(result!.reviewStatus).toBe('approved');
    });

    it('should preserve existing notes if not provided', () => {
      const stack = diffStacks.createDiffStack(tracker.db);

      diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack.id,
        status: 'approved',
        notes: 'Initial notes',
      });

      // Update status without notes
      const updated = diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack.id,
        status: 'rejected',
      });

      expect(updated!.reviewNotes).toBe('Initial notes');
    });
  });

  describe('addStackReviewNotes', () => {
    it('should add review notes to a stack', () => {
      const stack = diffStacks.createDiffStack(tracker.db);

      const updated = diffStacks.addStackReviewNotes(
        tracker.db,
        stack.id,
        'These are my notes'
      );

      expect(updated).not.toBeNull();
      expect(updated!.reviewNotes).toBe('These are my notes');
    });

    it('should update existing notes', () => {
      const stack = diffStacks.createDiffStack(tracker.db);

      diffStacks.addStackReviewNotes(tracker.db, stack.id, 'First notes');
      const updated = diffStacks.addStackReviewNotes(
        tracker.db,
        stack.id,
        'Updated notes'
      );

      expect(updated!.reviewNotes).toBe('Updated notes');
    });

    it('should return null for non-existent stack', () => {
      const result = diffStacks.addStackReviewNotes(
        tracker.db,
        'ds-nonexistent',
        'Notes'
      );
      expect(result).toBeNull();
    });
  });

  describe('isValidStatusTransition', () => {
    it('should validate pending transitions', () => {
      expect(diffStacks.isValidStatusTransition('pending', 'approved')).toBe(true);
      expect(diffStacks.isValidStatusTransition('pending', 'rejected')).toBe(true);
      expect(diffStacks.isValidStatusTransition('pending', 'abandoned')).toBe(true);
      expect(diffStacks.isValidStatusTransition('pending', 'merged')).toBe(false);
    });

    it('should validate approved transitions', () => {
      expect(diffStacks.isValidStatusTransition('approved', 'merged')).toBe(true);
      expect(diffStacks.isValidStatusTransition('approved', 'rejected')).toBe(true);
      expect(diffStacks.isValidStatusTransition('approved', 'pending')).toBe(true);
      expect(diffStacks.isValidStatusTransition('approved', 'abandoned')).toBe(true);
    });

    it('should not allow transitions from merged', () => {
      expect(diffStacks.isValidStatusTransition('merged', 'pending')).toBe(false);
      expect(diffStacks.isValidStatusTransition('merged', 'approved')).toBe(false);
      expect(diffStacks.isValidStatusTransition('merged', 'rejected')).toBe(false);
      expect(diffStacks.isValidStatusTransition('merged', 'abandoned')).toBe(false);
    });

    it('should allow same status transition', () => {
      expect(diffStacks.isValidStatusTransition('pending', 'pending')).toBe(true);
      expect(diffStacks.isValidStatusTransition('approved', 'approved')).toBe(true);
      expect(diffStacks.isValidStatusTransition('merged', 'merged')).toBe(true);
    });

    it('should allow abandoned to be reopened', () => {
      expect(diffStacks.isValidStatusTransition('abandoned', 'pending')).toBe(true);
      expect(diffStacks.isValidStatusTransition('abandoned', 'approved')).toBe(false);
    });
  });

  describe('enqueueStack / dequeueStack', () => {
    it('should add approved stack to queue', () => {
      const stack = diffStacks.createDiffStack(tracker.db);

      // Must approve first
      diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack.id,
        status: 'approved',
      });

      const queued = diffStacks.enqueueStack(tracker.db, stack.id);

      expect(queued).not.toBeNull();
      expect(queued!.queuePosition).toBe(0);
    });

    it('should throw when queueing non-approved stack', () => {
      const stack = diffStacks.createDiffStack(tracker.db);

      expect(() => {
        diffStacks.enqueueStack(tracker.db, stack.id);
      }).toThrow('Only approved stacks can be queued');
    });

    it('should maintain queue order', () => {
      const stack1 = diffStacks.createDiffStack(tracker.db, { name: 'Stack 1' });
      const stack2 = diffStacks.createDiffStack(tracker.db, { name: 'Stack 2' });
      const stack3 = diffStacks.createDiffStack(tracker.db, { name: 'Stack 3' });

      // Approve all stacks
      diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack1.id,
        status: 'approved',
      });
      diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack2.id,
        status: 'approved',
      });
      diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack3.id,
        status: 'approved',
      });

      diffStacks.enqueueStack(tracker.db, stack1.id);
      diffStacks.enqueueStack(tracker.db, stack2.id);
      diffStacks.enqueueStack(tracker.db, stack3.id);

      const queued = diffStacks.getQueuedStacks(tracker.db);

      expect(queued).toHaveLength(3);
      expect(queued[0].id).toBe(stack1.id);
      expect(queued[0].queuePosition).toBe(0);
      expect(queued[1].id).toBe(stack2.id);
      expect(queued[1].queuePosition).toBe(1);
      expect(queued[2].id).toBe(stack3.id);
      expect(queued[2].queuePosition).toBe(2);
    });

    it('should remove from queue and compact positions', () => {
      const stack1 = diffStacks.createDiffStack(tracker.db, { name: 'Stack 1' });
      const stack2 = diffStacks.createDiffStack(tracker.db, { name: 'Stack 2' });
      const stack3 = diffStacks.createDiffStack(tracker.db, { name: 'Stack 3' });

      // Approve all stacks
      for (const s of [stack1, stack2, stack3]) {
        diffStacks.setStackReviewStatus(tracker.db, {
          stackId: s.id,
          status: 'approved',
        });
      }

      diffStacks.enqueueStack(tracker.db, stack1.id);
      diffStacks.enqueueStack(tracker.db, stack2.id);
      diffStacks.enqueueStack(tracker.db, stack3.id);

      // Remove stack2 from queue
      const dequeued = diffStacks.dequeueStack(tracker.db, stack2.id);
      expect(dequeued).not.toBeNull();
      expect(dequeued!.queuePosition).toBeNull();

      // Check remaining queue
      const queued = diffStacks.getQueuedStacks(tracker.db);
      expect(queued).toHaveLength(2);
      expect(queued[0].id).toBe(stack1.id);
      expect(queued[0].queuePosition).toBe(0);
      expect(queued[1].id).toBe(stack3.id);
      expect(queued[1].queuePosition).toBe(1);
    });
  });

  describe('reorderQueue', () => {
    it('should reorder the queue', () => {
      const stack1 = diffStacks.createDiffStack(tracker.db, { name: 'Stack 1' });
      const stack2 = diffStacks.createDiffStack(tracker.db, { name: 'Stack 2' });
      const stack3 = diffStacks.createDiffStack(tracker.db, { name: 'Stack 3' });

      // Approve and enqueue all
      for (const s of [stack1, stack2, stack3]) {
        diffStacks.setStackReviewStatus(tracker.db, {
          stackId: s.id,
          status: 'approved',
        });
        diffStacks.enqueueStack(tracker.db, s.id);
      }

      // Reorder: stack3, stack1, stack2
      const reordered = diffStacks.reorderQueue(tracker.db, 'main', [
        stack3.id,
        stack1.id,
        stack2.id,
      ]);

      expect(reordered).toHaveLength(3);
      expect(reordered[0].id).toBe(stack3.id);
      expect(reordered[0].queuePosition).toBe(0);
      expect(reordered[1].id).toBe(stack1.id);
      expect(reordered[1].queuePosition).toBe(1);
      expect(reordered[2].id).toBe(stack2.id);
      expect(reordered[2].queuePosition).toBe(2);
    });

    it('should throw if stacks are missing', () => {
      const stack1 = diffStacks.createDiffStack(tracker.db, { name: 'Stack 1' });
      const stack2 = diffStacks.createDiffStack(tracker.db, { name: 'Stack 2' });

      // Approve and enqueue
      for (const s of [stack1, stack2]) {
        diffStacks.setStackReviewStatus(tracker.db, {
          stackId: s.id,
          status: 'approved',
        });
        diffStacks.enqueueStack(tracker.db, s.id);
      }

      expect(() => {
        diffStacks.reorderQueue(tracker.db, 'main', [stack1.id]);
      }).toThrow();
    });

    it('should throw if unknown stack in reorder', () => {
      const stack1 = diffStacks.createDiffStack(tracker.db, { name: 'Stack 1' });

      diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack1.id,
        status: 'approved',
      });
      diffStacks.enqueueStack(tracker.db, stack1.id);

      expect(() => {
        diffStacks.reorderQueue(tracker.db, 'main', [stack1.id, 'ds-unknown']);
      }).toThrow('must include all');
    });
  });

  describe('removeCheckpointFromStack', () => {
    it('should remove a checkpoint and compact positions', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');
      const commit3 = makeCommit('Commit 3');

      const cp1 = createCheckpoint(commit1);
      const cp2 = createCheckpoint(commit2);
      const cp3 = createCheckpoint(commit3);

      const stack = diffStacks.createDiffStack(tracker.db, {
        checkpointIds: [cp1.id, cp2.id, cp3.id],
      });

      const removed = diffStacks.removeCheckpointFromStack(
        tracker.db,
        stack.id,
        cp2.id
      );
      expect(removed).toBe(true);

      const cps = diffStacks.getCheckpointsInStack(tracker.db, stack.id);
      expect(cps).toHaveLength(2);
      expect(cps[0].id).toBe(cp1.id);
      expect(cps[0].position).toBe(0);
      expect(cps[1].id).toBe(cp3.id);
      expect(cps[1].position).toBe(1);
    });

    it('should return false for non-existent entry', () => {
      const stack = diffStacks.createDiffStack(tracker.db);
      const removed = diffStacks.removeCheckpointFromStack(
        tracker.db,
        stack.id,
        'cp-nonexistent'
      );
      expect(removed).toBe(false);
    });
  });

  describe('reorderStackCheckpoints', () => {
    it('should reorder checkpoints', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');
      const commit3 = makeCommit('Commit 3');

      const cp1 = createCheckpoint(commit1);
      const cp2 = createCheckpoint(commit2);
      const cp3 = createCheckpoint(commit3);

      const stack = diffStacks.createDiffStack(tracker.db, {
        checkpointIds: [cp1.id, cp2.id, cp3.id],
      });

      // Reverse order
      diffStacks.reorderStackCheckpoints(tracker.db, stack.id, [
        cp3.id,
        cp2.id,
        cp1.id,
      ]);

      const cps = diffStacks.getCheckpointsInStack(tracker.db, stack.id);
      expect(cps[0].id).toBe(cp3.id);
      expect(cps[1].id).toBe(cp2.id);
      expect(cps[2].id).toBe(cp1.id);
    });

    it('should throw if checkpoints are missing', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');

      const cp1 = createCheckpoint(commit1);
      const cp2 = createCheckpoint(commit2);

      const stack = diffStacks.createDiffStack(tracker.db, {
        checkpointIds: [cp1.id, cp2.id],
      });

      expect(() => {
        diffStacks.reorderStackCheckpoints(tracker.db, stack.id, [cp1.id]);
      }).toThrow();
    });
  });

  describe('deleteDiffStack', () => {
    it('should delete a stack and cascade delete entries', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit = makeCommit('Test commit');
      const cp = createCheckpoint(commit);

      const stack = diffStacks.createDiffStack(tracker.db, {
        checkpointIds: [cp.id],
      });

      const deleted = diffStacks.deleteDiffStack(tracker.db, stack.id);
      expect(deleted).toBe(true);

      // Stack should be gone
      const retrieved = diffStacks.getDiffStack(tracker.db, stack.id);
      expect(retrieved).toBeNull();

      // Checkpoint should still exist but not in any stack
      const stacks = diffStacks.getStacksForCheckpoint(tracker.db, cp.id);
      expect(stacks).toHaveLength(0);
    });

    it('should return false for non-existent stack', () => {
      const deleted = diffStacks.deleteDiffStack(tracker.db, 'ds-nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('deleteStacksByStatus', () => {
    it('should delete all stacks with given status', () => {
      const stack1 = diffStacks.createDiffStack(tracker.db, { name: 'Stack 1' });
      const stack2 = diffStacks.createDiffStack(tracker.db, { name: 'Stack 2' });
      diffStacks.createDiffStack(tracker.db, { name: 'Stack 3' });

      diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack1.id,
        status: 'abandoned',
      });
      diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack2.id,
        status: 'abandoned',
      });

      const deleted = diffStacks.deleteStacksByStatus(tracker.db, 'abandoned');
      expect(deleted).toBe(2);

      const remaining = diffStacks.listDiffStacks(tracker.db);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].name).toBe('Stack 3');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Stream-based Operations
  // ─────────────────────────────────────────────────────────────────────────────

  describe('createCheckpointsFromStream', () => {
    it('should create checkpoints from stream commits', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });

      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');
      const commit3 = makeCommit('Commit 3');

      const cps = diffStacks.createCheckpointsFromStream(
        tracker.db,
        testRepo.path,
        streamId
      );

      expect(cps).toHaveLength(3);
      expect(cps[0].commitSha).toBe(commit1);
      expect(cps[1].commitSha).toBe(commit2);
      expect(cps[2].commitSha).toBe(commit3);
      expect(cps[0].streamId).toBe(streamId);
    });

    it('should reuse existing checkpoints', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });

      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');

      // Create checkpoint for commit1 manually
      const existingCp = checkpoints.createCheckpoint(tracker.db, {
        streamId,
        commitSha: commit1,
        message: 'Manually created',
      });

      const cps = diffStacks.createCheckpointsFromStream(
        tracker.db,
        testRepo.path,
        streamId
      );

      expect(cps).toHaveLength(2);
      // First checkpoint should be the existing one
      expect(cps[0].id).toBe(existingCp.id);
      // Second checkpoint should be new
      expect(cps[1].commitSha).toBe(commit2);
    });

    it('should return empty array when no commits since base', () => {
      const cps = diffStacks.createCheckpointsFromStream(
        tracker.db,
        testRepo.path,
        streamId
      );

      expect(cps).toHaveLength(0);
    });

    it('should throw for non-existent stream', () => {
      expect(() => {
        diffStacks.createCheckpointsFromStream(
          tracker.db,
          testRepo.path,
          'nonexistent-stream'
        );
      }).toThrow('Stream not found');
    });

    it('should respect custom commit range', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });

      makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');
      const commit3 = makeCommit('Commit 3');
      makeCommit('Commit 4');

      // Get only commit2 and commit3
      const cps = diffStacks.createCheckpointsFromStream(
        tracker.db,
        testRepo.path,
        streamId,
        { from: git.resolveRef(`${commit2}^`, { cwd: testRepo.path }), to: commit3 }
      );

      expect(cps).toHaveLength(2);
      expect(cps[0].commitSha).toBe(commit2);
      expect(cps[1].commitSha).toBe(commit3);
    });
  });

  describe('createStackFromStream', () => {
    it('should create a stack with checkpoints from stream', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });

      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');

      const stack = diffStacks.createStackFromStream(tracker.db, testRepo.path, {
        streamId,
        name: 'My Stack',
        description: 'Test stack',
        targetBranch: 'main',
      });

      expect(stack.name).toBe('My Stack');
      expect(stack.description).toBe('Test stack');
      expect(stack.targetBranch).toBe('main');
      expect(stack.reviewStatus).toBe('pending');
      expect(stack.checkpoints).toHaveLength(2);
      expect(stack.checkpoints[0].commitSha).toBe(commit1);
      expect(stack.checkpoints[0].position).toBe(0);
      expect(stack.checkpoints[1].commitSha).toBe(commit2);
      expect(stack.checkpoints[1].position).toBe(1);
    });

    it('should create empty stack when no commits', () => {
      const stack = diffStacks.createStackFromStream(tracker.db, testRepo.path, {
        streamId,
        name: 'Empty Stack',
      });

      expect(stack.name).toBe('Empty Stack');
      expect(stack.checkpoints).toHaveLength(0);
    });
  });

  describe('cherryPickStackToTarget', () => {
    it('should cherry-pick approved stack to target', () => {
      // Create commits on stream
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Feature commit 1');
      const commit2 = makeCommit('Feature commit 2');

      // Create and approve stack
      const stack = diffStacks.createStackFromStream(tracker.db, testRepo.path, {
        streamId,
        targetBranch: 'main',
      });

      diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack.id,
        status: 'approved',
      });

      // Cherry-pick to main
      const result = diffStacks.cherryPickStackToTarget(
        tracker.db,
        testRepo.path,
        stack.id,
        testRepo.path
      );

      expect(result.success).toBe(true);
      expect(result.cherryPickedCommits).toHaveLength(2);
      expect(result.cherryPickedCommits[0]).toBe(commit1);
      expect(result.cherryPickedCommits[1]).toBe(commit2);
      expect(result.newCommits).toHaveLength(2);

      // Verify stack is marked as merged
      const updatedStack = diffStacks.getDiffStack(tracker.db, stack.id);
      expect(updatedStack!.reviewStatus).toBe('merged');

      // Verify commits are on main
      git.checkout('main', { cwd: testRepo.path });
      const mainHead = git.getHead({ cwd: testRepo.path });
      expect(result.newCommits).toContain(mainHead);
    });

    it('should fail for non-approved stack', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      makeCommit('Feature commit');

      const stack = diffStacks.createStackFromStream(tracker.db, testRepo.path, {
        streamId,
      });

      const result = diffStacks.cherryPickStackToTarget(
        tracker.db,
        testRepo.path,
        stack.id,
        testRepo.path
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not approved');
    });

    it('should fail for non-existent stack', () => {
      const result = diffStacks.cherryPickStackToTarget(
        tracker.db,
        testRepo.path,
        'ds-nonexistent',
        testRepo.path
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should handle empty stack', () => {
      const stack = diffStacks.createStackFromStream(tracker.db, testRepo.path, {
        streamId,
      });

      diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack.id,
        status: 'approved',
      });

      const result = diffStacks.cherryPickStackToTarget(
        tracker.db,
        testRepo.path,
        stack.id,
        testRepo.path
      );

      expect(result.success).toBe(true);
      expect(result.cherryPickedCommits).toHaveLength(0);
      expect(result.newCommits).toHaveLength(0);

      // Stack should still be marked as merged
      const updatedStack = diffStacks.getDiffStack(tracker.db, stack.id);
      expect(updatedStack!.reviewStatus).toBe('merged');
    });

    it('should return conflict info on cherry-pick conflict', () => {
      // Create stream with a commit that modifies a file
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const filePath = path.join(testRepo.path, 'conflict-file.txt');
      fs.writeFileSync(filePath, 'stream content');
      git.stageAll({ cwd: testRepo.path });
      git.commit('Stream change', { cwd: testRepo.path });

      // Go back to main and create conflicting change
      git.checkout('main', { cwd: testRepo.path });
      fs.writeFileSync(filePath, 'main content');
      git.stageAll({ cwd: testRepo.path });
      git.commit('Main change', { cwd: testRepo.path });

      // Create and approve stack
      const stack = diffStacks.createStackFromStream(tracker.db, testRepo.path, {
        streamId,
        targetBranch: 'main',
      });

      diffStacks.setStackReviewStatus(tracker.db, {
        stackId: stack.id,
        status: 'approved',
      });

      // Cherry-pick should fail with conflict
      const result = diffStacks.cherryPickStackToTarget(
        tracker.db,
        testRepo.path,
        stack.id,
        testRepo.path
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Conflict');
      expect(result.conflicts).toBeDefined();
      expect(result.conflicts!.length).toBeGreaterThan(0);

      // Stack should NOT be marked as merged
      const updatedStack = diffStacks.getDiffStack(tracker.db, stack.id);
      expect(updatedStack!.reviewStatus).toBe('approved');
    });
  });
});
