import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker } from '../src/tracker.js';
import { createTestRepo } from './setup.js';
import * as stacks from '../src/stacks.js';
import * as git from '../src/git/index.js';
import * as fs from 'fs';
import * as path from 'path';

describe('Review Block Operations', () => {
  let tracker: MultiAgentRepoTracker;
  let testRepo: ReturnType<typeof createTestRepo>;
  let streamId: string;

  beforeEach(() => {
    testRepo = createTestRepo();
    tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });

    // Create a stream with stacked review enabled
    streamId = tracker.createStream({
      name: 'test-stream',
      agentId: 'agent-1',
      enableStackedReview: true,
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

  describe('createReviewBlock', () => {
    it('should create a review block with commits', () => {
      // Make some commits on the stream branch
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('First commit');
      const commit2 = makeCommit('Second commit');

      const blockId = stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit1, commit2],
        title: 'Add feature X',
        description: 'Implements feature X with two commits',
      });

      expect(blockId).toMatch(/^rb-/);

      const block = stacks.getReviewBlock(tracker.db, blockId);
      expect(block).not.toBeNull();
      expect(block!.title).toBe('Add feature X');
      expect(block!.description).toBe('Implements feature X with two commits');
      expect(block!.reviewStatus).toBe('draft');
      expect(block!.commits).toHaveLength(2);
      expect(block!.commits[0].commitHash).toBe(commit1);
      expect(block!.commits[1].commitHash).toBe(commit2);
    });

    it('should require at least one commit', () => {
      expect(() => {
        stacks.createReviewBlock(tracker.db, {
          streamId,
          commits: [],
          title: 'Empty block',
        });
      }).toThrow('At least one commit is required');
    });

    it('should reject if stream does not have stacked review enabled', () => {
      const noStackStream = tracker.createStream({
        name: 'no-stack-stream',
        agentId: 'agent-1',
        enableStackedReview: false,
      });

      expect(() => {
        stacks.createReviewBlock(tracker.db, {
          streamId: noStackStream,
          commits: ['abc123'],
          title: 'Should fail',
        });
      }).toThrow('does not have stacked review enabled');
    });

    it('should auto-increment position for multiple blocks', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');

      const block1Id = stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit1],
        title: 'Block 1',
      });

      const block2Id = stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit2],
        title: 'Block 2',
      });

      const block1 = stacks.getReviewBlock(tracker.db, block1Id);
      const block2 = stacks.getReviewBlock(tracker.db, block2Id);

      expect(block1!.position).toBe(0);
      expect(block2!.position).toBe(1);
    });
  });

  describe('getStack', () => {
    it('should return blocks ordered by position', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');
      const commit3 = makeCommit('Commit 3');

      stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit1],
        title: 'First block',
      });

      stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit2],
        title: 'Second block',
      });

      stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit3],
        title: 'Third block',
      });

      const stack = stacks.getStack(tracker.db, streamId);

      expect(stack).toHaveLength(3);
      expect(stack[0].title).toBe('First block');
      expect(stack[1].title).toBe('Second block');
      expect(stack[2].title).toBe('Third block');
      expect(stack[0].position).toBe(0);
      expect(stack[1].position).toBe(1);
      expect(stack[2].position).toBe(2);
    });

    it('should return empty array for stream with no blocks', () => {
      const stack = stacks.getStack(tracker.db, streamId);
      expect(stack).toHaveLength(0);
    });

    it('should filter by stack name', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');

      stacks.createReviewBlock(tracker.db, {
        streamId,
        stackName: 'default',
        commits: [commit1],
        title: 'Default stack block',
      });

      stacks.createReviewBlock(tracker.db, {
        streamId,
        stackName: 'review-v2',
        commits: [commit2],
        title: 'V2 stack block',
      });

      const defaultStack = stacks.getStack(tracker.db, streamId, 'default');
      const v2Stack = stacks.getStack(tracker.db, streamId, 'review-v2');

      expect(defaultStack).toHaveLength(1);
      expect(defaultStack[0].title).toBe('Default stack block');

      expect(v2Stack).toHaveLength(1);
      expect(v2Stack[0].title).toBe('V2 stack block');
    });
  });

  describe('setReviewStatus', () => {
    it('should update review status', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit = makeCommit('Test commit');

      const blockId = stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit],
        title: 'Test block',
      });

      stacks.setReviewStatus(tracker.db, {
        reviewBlockId: blockId,
        status: 'approved',
        reviewer: 'reviewer-1',
      });

      const block = stacks.getReviewBlock(tracker.db, blockId);
      expect(block!.reviewStatus).toBe('approved');
      expect(block!.reviewedBy).toBe('reviewer-1');
      expect(block!.reviewedAt).toBeGreaterThan(0);
    });

    it('should prevent changing merged status', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit = makeCommit('Test commit');

      const blockId = stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit],
        title: 'Test block',
      });

      // Set to merged
      stacks.setReviewStatus(tracker.db, {
        reviewBlockId: blockId,
        status: 'merged',
      });

      // Try to change from merged
      expect(() => {
        stacks.setReviewStatus(tracker.db, {
          reviewBlockId: blockId,
          status: 'draft',
        });
      }).toThrow('Cannot change status of merged review block');
    });
  });

  describe('deleteReviewBlock', () => {
    it('should delete block and cascade delete entries', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit = makeCommit('Test commit');

      const blockId = stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit],
        title: 'Test block',
      });

      // Verify block exists
      expect(stacks.getReviewBlock(tracker.db, blockId)).not.toBeNull();

      // Delete
      stacks.deleteReviewBlock(tracker.db, blockId);

      // Verify gone
      expect(stacks.getReviewBlock(tracker.db, blockId)).toBeNull();

      // Verify entries are also gone (cascade)
      const entries = stacks.getStackEntriesForBlock(tracker.db, blockId);
      expect(entries).toHaveLength(0);
    });
  });

  describe('Stack Configuration', () => {
    it('should return default config when not set', () => {
      const config = stacks.getStackConfig(tracker.db, streamId);

      expect(config.autoPopulate).toBe(true);
      expect(config.groupingStrategy).toBe('per-commit');
      expect(config.rebuildBehavior?.matchStrategy).toBe('patch-id');
    });

    it('should save and retrieve config', () => {
      stacks.setStackConfig(tracker.db, streamId, 'default', {
        autoPopulate: false,
        groupingStrategy: 'manual',
      });

      const config = stacks.getStackConfig(tracker.db, streamId);

      expect(config.autoPopulate).toBe(false);
      expect(config.groupingStrategy).toBe('manual');
      // Should still have defaults for unset values
      expect(config.rebuildBehavior?.matchStrategy).toBe('patch-id');
    });

    it('should merge config updates', () => {
      stacks.setStackConfig(tracker.db, streamId, 'default', {
        autoPopulate: false,
      });

      stacks.setStackConfig(tracker.db, streamId, 'default', {
        groupingStrategy: 'manual',
      });

      const config = stacks.getStackConfig(tracker.db, streamId);

      expect(config.autoPopulate).toBe(false); // From first update
      expect(config.groupingStrategy).toBe('manual'); // From second update
    });
  });

  describe('listStacks', () => {
    it('should list all stack names for a stream', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');

      stacks.createReviewBlock(tracker.db, {
        streamId,
        stackName: 'default',
        commits: [commit1],
        title: 'Default block',
      });

      stacks.createReviewBlock(tracker.db, {
        streamId,
        stackName: 'feature-review',
        commits: [commit2],
        title: 'Feature block',
      });

      const stackNames = stacks.listStacks(tracker.db, streamId);

      expect(stackNames).toContain('default');
      expect(stackNames).toContain('feature-review');
    });

    it('should return default for stream with no blocks', () => {
      const stackNames = stacks.listStacks(tracker.db, streamId);
      expect(stackNames).toEqual(['default']);
    });
  });

  describe('autoPopulateStack', () => {
    it('should create review blocks for untracked commits', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      makeCommit('First commit');
      makeCommit('Second commit');
      makeCommit('Third commit');

      // Initially no blocks
      expect(stacks.getStack(tracker.db, streamId)).toHaveLength(0);

      // Auto-populate
      stacks.autoPopulateStack(tracker.db, testRepo.path, streamId);

      // Should have 3 blocks now
      const stack = stacks.getStack(tracker.db, streamId);
      expect(stack).toHaveLength(3);
      expect(stack[0].title).toBe('First commit');
      expect(stack[1].title).toBe('Second commit');
      expect(stack[2].title).toBe('Third commit');
    });

    it('should not duplicate already tracked commits', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('First commit');
      makeCommit('Second commit');

      // Manually add first commit
      stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit1],
        title: 'Manual block',
      });

      // Auto-populate
      stacks.autoPopulateStack(tracker.db, testRepo.path, streamId);

      // Should have 2 blocks (1 manual + 1 auto)
      const stack = stacks.getStack(tracker.db, streamId);
      expect(stack).toHaveLength(2);
      expect(stack[0].title).toBe('Manual block');
      expect(stack[1].title).toBe('Second commit');
    });
  });

  describe('rebuildStack', () => {
    it('should delete blocks when all commits removed', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit = makeCommit('Will be removed');

      const blockId = stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit],
        title: 'Test block',
      });

      // Verify block exists
      expect(stacks.getReviewBlock(tracker.db, blockId)).not.toBeNull();

      // Reset to base commit (removing all commits)
      git.resetHard(tracker.getStream(streamId)!.baseCommit, { cwd: testRepo.path });

      // Rebuild stack
      stacks.rebuildStack(tracker.db, testRepo.path, streamId);

      // Block should be deleted
      expect(stacks.getReviewBlock(tracker.db, blockId)).toBeNull();
    });

    it('should auto-populate new commits when rebuilding with empty stack', () => {
      // Ensure auto-populate is enabled
      stacks.setStackConfig(tracker.db, streamId, 'default', { autoPopulate: true });

      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      makeCommit('New commit 1');
      makeCommit('New commit 2');

      // Rebuild with no existing blocks
      stacks.rebuildStack(tracker.db, testRepo.path, streamId);

      // Should have auto-populated
      const stack = stacks.getStack(tracker.db, streamId);
      expect(stack).toHaveLength(2);
    });

    it('should not auto-populate when disabled', () => {
      // Disable auto-populate
      stacks.setStackConfig(tracker.db, streamId, 'default', { autoPopulate: false });

      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      makeCommit('New commit');

      // Rebuild with no existing blocks
      stacks.rebuildStack(tracker.db, testRepo.path, streamId);

      // Should NOT have auto-populated
      const stack = stacks.getStack(tracker.db, streamId);
      expect(stack).toHaveLength(0);
    });
  });

  describe('addCommitsToBlock', () => {
    it('should add commits to existing block', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('First commit');
      const commit2 = makeCommit('Second commit');

      const blockId = stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit1],
        title: 'Initial block',
      });

      stacks.addCommitsToBlock(tracker.db, blockId, [commit2]);

      const block = stacks.getReviewBlock(tracker.db, blockId);
      expect(block!.commits).toHaveLength(2);
      expect(block!.commits[0].commitHash).toBe(commit1);
      expect(block!.commits[1].commitHash).toBe(commit2);
    });

    it('should reject adding to merged block', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');

      const blockId = stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit1],
        title: 'Merged block',
      });

      stacks.setReviewStatus(tracker.db, {
        reviewBlockId: blockId,
        status: 'merged',
      });

      expect(() => {
        stacks.addCommitsToBlock(tracker.db, blockId, [commit2]);
      }).toThrow('Cannot modify merged review block');
    });
  });

  describe('removeCommitsFromBlock', () => {
    it('should remove commits from block', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('First commit');
      const commit2 = makeCommit('Second commit');
      const commit3 = makeCommit('Third commit');

      const blockId = stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit1, commit2, commit3],
        title: 'Multi-commit block',
      });

      stacks.removeCommitsFromBlock(tracker.db, blockId, [commit2]);

      const block = stacks.getReviewBlock(tracker.db, blockId);
      expect(block!.commits).toHaveLength(2);
      expect(block!.commits[0].commitHash).toBe(commit1);
      expect(block!.commits[1].commitHash).toBe(commit3);
      // Positions should be renumbered
      expect(block!.commits[0].commitPosition).toBe(0);
      expect(block!.commits[1].commitPosition).toBe(1);
    });

    it('should delete block when all commits removed', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit = makeCommit('Only commit');

      const blockId = stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit],
        title: 'Single commit block',
      });

      stacks.removeCommitsFromBlock(tracker.db, blockId, [commit]);

      expect(stacks.getReviewBlock(tracker.db, blockId)).toBeNull();
    });
  });

  describe('splitReviewBlock', () => {
    it('should split block at specified position', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');
      const commit3 = makeCommit('Commit 3');

      const blockId = stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit1, commit2, commit3],
        title: 'Original block',
      });

      const newBlockId = stacks.splitReviewBlock(
        tracker.db,
        blockId,
        0, // Split after first commit
        'Split block'
      );

      const originalBlock = stacks.getReviewBlock(tracker.db, blockId);
      const newBlock = stacks.getReviewBlock(tracker.db, newBlockId);

      // Original keeps first commit
      expect(originalBlock!.commits).toHaveLength(1);
      expect(originalBlock!.commits[0].commitHash).toBe(commit1);

      // New block gets remaining commits
      expect(newBlock!.commits).toHaveLength(2);
      expect(newBlock!.commits[0].commitHash).toBe(commit2);
      expect(newBlock!.commits[1].commitHash).toBe(commit3);
      expect(newBlock!.title).toBe('Split block');
      expect(newBlock!.position).toBe(originalBlock!.position + 1);
    });

    it('should reject invalid split position', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');

      const blockId = stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit1, commit2],
        title: 'Two commit block',
      });

      // Can't split at position 1 (last position)
      expect(() => {
        stacks.splitReviewBlock(tracker.db, blockId, 1, 'Invalid');
      }).toThrow('Invalid split position');

      // Can't split at negative position
      expect(() => {
        stacks.splitReviewBlock(tracker.db, blockId, -1, 'Invalid');
      }).toThrow('Invalid split position');
    });
  });

  describe('mergeReviewBlocks', () => {
    it('should merge multiple blocks into one', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');
      const commit3 = makeCommit('Commit 3');

      const block1Id = stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit1],
        title: 'Block 1',
      });

      const block2Id = stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit2],
        title: 'Block 2',
      });

      const block3Id = stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit3],
        title: 'Block 3',
      });

      const mergedId = stacks.mergeReviewBlocks(
        tracker.db,
        [block1Id, block2Id, block3Id],
        'Merged block',
        'Combined commits'
      );

      expect(mergedId).toBe(block1Id); // Uses first block's ID

      const merged = stacks.getReviewBlock(tracker.db, mergedId);
      expect(merged!.title).toBe('Merged block');
      expect(merged!.description).toBe('Combined commits');
      expect(merged!.commits).toHaveLength(3);
      expect(merged!.commits[0].commitHash).toBe(commit1);
      expect(merged!.commits[1].commitHash).toBe(commit2);
      expect(merged!.commits[2].commitHash).toBe(commit3);

      // Other blocks should be deleted
      expect(stacks.getReviewBlock(tracker.db, block2Id)).toBeNull();
      expect(stacks.getReviewBlock(tracker.db, block3Id)).toBeNull();

      // Stack should have only one block now
      const stack = stacks.getStack(tracker.db, streamId);
      expect(stack).toHaveLength(1);
    });

    it('should require at least two blocks', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit = makeCommit('Commit');

      const blockId = stacks.createReviewBlock(tracker.db, {
        streamId,
        commits: [commit],
        title: 'Only block',
      });

      expect(() => {
        stacks.mergeReviewBlocks(tracker.db, [blockId], 'Merged');
      }).toThrow('At least two review blocks are required');
    });

    it('should reject blocks from different stacks', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');

      const block1Id = stacks.createReviewBlock(tracker.db, {
        streamId,
        stackName: 'stack-a',
        commits: [commit1],
        title: 'Block A',
      });

      const block2Id = stacks.createReviewBlock(tracker.db, {
        streamId,
        stackName: 'stack-b',
        commits: [commit2],
        title: 'Block B',
      });

      expect(() => {
        stacks.mergeReviewBlocks(tracker.db, [block1Id, block2Id], 'Merged');
      }).toThrow('All blocks must be from the same stream and stack');
    });
  });
});
