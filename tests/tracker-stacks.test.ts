import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker } from '../src/tracker.js';
import { createTestRepo } from './setup.js';
import * as git from '../src/git/index.js';
import * as fs from 'fs';
import * as path from 'path';

describe('Tracker Stack Integration', () => {
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

  describe('Review Block CRUD via Tracker', () => {
    it('should create and retrieve review blocks', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit = makeCommit('Test commit');

      const blockId = tracker.createReviewBlock({
        streamId,
        commits: [commit],
        title: 'Test block',
        description: 'A test block',
      });

      expect(blockId).toMatch(/^rb-/);

      const block = tracker.getReviewBlock(blockId);
      expect(block).not.toBeNull();
      expect(block!.title).toBe('Test block');
      expect(block!.commits).toHaveLength(1);
    });

    it('should get stack of review blocks', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');

      tracker.createReviewBlock({
        streamId,
        commits: [commit1],
        title: 'Block 1',
      });

      tracker.createReviewBlock({
        streamId,
        commits: [commit2],
        title: 'Block 2',
      });

      const stack = tracker.getStack(streamId);
      expect(stack).toHaveLength(2);
      expect(stack[0]!.title).toBe('Block 1');
      expect(stack[1]!.title).toBe('Block 2');
    });

    it('should set review status', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit = makeCommit('Test commit');

      const blockId = tracker.createReviewBlock({
        streamId,
        commits: [commit],
        title: 'Review block',
      });

      tracker.setReviewStatus({
        reviewBlockId: blockId,
        status: 'approved',
        reviewer: 'reviewer-1',
      });

      const block = tracker.getReviewBlock(blockId);
      expect(block!.reviewStatus).toBe('approved');
      expect(block!.reviewedBy).toBe('reviewer-1');
    });

    it('should delete review block', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit = makeCommit('Test commit');

      const blockId = tracker.createReviewBlock({
        streamId,
        commits: [commit],
        title: 'To be deleted',
      });

      tracker.deleteReviewBlock(blockId);

      expect(tracker.getReviewBlock(blockId)).toBeNull();
    });
  });

  describe('Block Manipulation via Tracker', () => {
    it('should add commits to block', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');

      const blockId = tracker.createReviewBlock({
        streamId,
        commits: [commit1],
        title: 'Block',
      });

      tracker.addCommitsToBlock(blockId, [commit2]);

      const block = tracker.getReviewBlock(blockId);
      expect(block!.commits).toHaveLength(2);
    });

    it('should split review block', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');

      const blockId = tracker.createReviewBlock({
        streamId,
        commits: [commit1, commit2],
        title: 'Original',
      });

      const newBlockId = tracker.splitReviewBlock(blockId, 0, 'Split');

      const original = tracker.getReviewBlock(blockId);
      const split = tracker.getReviewBlock(newBlockId);

      expect(original!.commits).toHaveLength(1);
      expect(split!.commits).toHaveLength(1);
      expect(split!.title).toBe('Split');
    });

    it('should merge review blocks', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');

      const block1Id = tracker.createReviewBlock({
        streamId,
        commits: [commit1],
        title: 'Block 1',
      });

      const block2Id = tracker.createReviewBlock({
        streamId,
        commits: [commit2],
        title: 'Block 2',
      });

      const mergedId = tracker.mergeReviewBlocks(
        [block1Id, block2Id],
        'Merged',
        'Combined'
      );

      const merged = tracker.getReviewBlock(mergedId);
      expect(merged!.commits).toHaveLength(2);
      expect(merged!.title).toBe('Merged');

      // Block 2 should be deleted
      expect(tracker.getReviewBlock(block2Id)).toBeNull();
    });
  });

  describe('Stack Configuration via Tracker', () => {
    it('should get and set stack config', () => {
      const defaultConfig = tracker.getStackConfig(streamId);
      expect(defaultConfig.autoPopulate).toBe(true);

      tracker.setStackConfig(streamId, 'default', {
        autoPopulate: false,
        groupingStrategy: 'manual',
      });

      const updatedConfig = tracker.getStackConfig(streamId);
      expect(updatedConfig.autoPopulate).toBe(false);
      expect(updatedConfig.groupingStrategy).toBe('manual');
    });

    it('should list stacks', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');

      tracker.createReviewBlock({
        streamId,
        stackName: 'default',
        commits: [commit1],
        title: 'Default block',
      });

      tracker.createReviewBlock({
        streamId,
        stackName: 'feature-a',
        commits: [commit2],
        title: 'Feature A block',
      });

      const stacks = tracker.listStacks(streamId);
      expect(stacks).toContain('default');
      expect(stacks).toContain('feature-a');
    });
  });

  describe('Auto-populate via Tracker', () => {
    it('should auto-populate stack with untracked commits', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      makeCommit('Commit 1');
      makeCommit('Commit 2');

      // Initially no blocks
      expect(tracker.getStack(streamId)).toHaveLength(0);

      // Auto-populate
      tracker.autoPopulateStack(streamId);

      // Should have 2 blocks now
      const stack = tracker.getStack(streamId);
      expect(stack).toHaveLength(2);
    });
  });
});
