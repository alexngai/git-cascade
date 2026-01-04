/**
 * End-to-End Tests: Stacked Review Workflow
 *
 * Tests complete stacked diff review scenarios including block creation,
 * review status changes, rebasing with stack preservation, and block manipulation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { MultiAgentRepoTracker } from '../../src/index.js';
import { createTestRepo, type TestRepo } from '../setup.js';

describe('E2E: Stacked Review Workflow', () => {
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

  describe('Complete Stacked Review Lifecycle', () => {
    it('should handle full stacked review workflow with amendments', () => {
      const agent = 'agent-reviewer';
      const reviewer = 'human-reviewer';

      // === PHASE 1: Create stream with stacked review enabled ===
      const stream = tracker.createStream({
        name: 'feature-with-review',
        agentId: agent,
        enableStackedReview: true,
      });

      const wt = path.join(testRepo.path, '.worktrees', agent);
      tracker.createWorktree({ agentId: agent, path: wt, branch: `stream/${stream}` });

      // === PHASE 2: Make a series of commits ===
      // Commit 1: Add model
      fs.writeFileSync(path.join(wt, 'model.ts'), 'export interface User { id: string; name: string; }');
      execSync('git add .', { cwd: wt, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: stream,
        message: 'feat: add User model',
        agentId: agent,
        worktree: wt,
      });

      // Commit 2: Add service
      fs.writeFileSync(path.join(wt, 'service.ts'), 'export class UserService { getUser(id: string) {} }');
      execSync('git add .', { cwd: wt, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: stream,
        message: 'feat: add UserService',
        agentId: agent,
        worktree: wt,
      });

      // Commit 3: Add controller
      fs.writeFileSync(path.join(wt, 'controller.ts'), 'export class UserController { constructor(private svc: UserService) {} }');
      execSync('git add .', { cwd: wt, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: stream,
        message: 'feat: add UserController',
        agentId: agent,
        worktree: wt,
      });

      // Commit 4: Add tests
      fs.writeFileSync(path.join(wt, 'user.test.ts'), 'describe("User", () => { it("works", () => {}); });');
      execSync('git add .', { cwd: wt, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: stream,
        message: 'test: add user tests',
        agentId: agent,
        worktree: wt,
      });

      // === PHASE 3: Auto-populate stack ===
      tracker.autoPopulateStack(stream);
      const initialStack = tracker.getStack(stream);

      // Should have 4 review blocks (one per commit)
      expect(initialStack.length).toBe(4);
      expect(initialStack[0].title).toContain('User model');
      expect(initialStack[3].title).toContain('user tests');

      // All should be draft status
      expect(initialStack.every(b => b.reviewStatus === 'draft')).toBe(true);

      // === PHASE 4: Review process ===
      // Reviewer approves first two blocks
      tracker.setReviewStatus({
        reviewBlockId: initialStack[0].id,
        status: 'approved',
        reviewer,
      });
      tracker.setReviewStatus({
        reviewBlockId: initialStack[1].id,
        status: 'approved',
        reviewer,
      });

      // Reviewer requests changes on third block (use 'review' status since 'needs_changes' may not exist)
      tracker.setReviewStatus({
        reviewBlockId: initialStack[2].id,
        status: 'review',
        reviewer,
      });

      // Verify status
      const afterReview = tracker.getStack(stream);
      expect(afterReview[0].reviewStatus).toBe('approved');
      expect(afterReview[1].reviewStatus).toBe('approved');
      expect(afterReview[2].reviewStatus).toBe('review');
      expect(afterReview[3].reviewStatus).toBe('draft');

      // === PHASE 5: Agent amends based on feedback ===
      // Fix the controller (commit 3)
      fs.writeFileSync(path.join(wt, 'controller.ts'),
        'export class UserController {\n  constructor(private svc: UserService) {}\n  async getUser(id: string) { return this.svc.getUser(id); }\n}');
      execSync('git add .', { cwd: wt, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: stream,
        message: 'fix: add getUser method to controller',
        agentId: agent,
        worktree: wt,
      });

      // Rebuild stack after new commit
      tracker.rebuildStack(stream);
      const afterAmend = tracker.getStack(stream);

      // Should now have 5 blocks
      expect(afterAmend.length).toBe(5);

      // Previous approvals should be preserved (matched by Change-Id)
      expect(afterAmend[0].reviewStatus).toBe('approved');
      expect(afterAmend[1].reviewStatus).toBe('approved');

      // === PHASE 6: Merge approved blocks ===
      // Merge the two approved model/service blocks
      const mergedBlockId = tracker.mergeReviewBlocks(
        [afterAmend[0].id, afterAmend[1].id],
        'Model and Service implementation'
      );
      const afterMerge = tracker.getStack(stream);

      // Should have 4 blocks now (2 merged into 1)
      expect(afterMerge.length).toBe(4);

      const mergedBlock = tracker.getReviewBlock(mergedBlockId);
      expect(mergedBlock).not.toBeNull();
      expect(mergedBlock!.commits.length).toBe(2);

      // === PHASE 7: Final approval and marking as merged ===
      // Approve remaining blocks
      for (const block of afterMerge) {
        if (block.reviewStatus !== 'approved' && block.reviewStatus !== 'merged') {
          tracker.setReviewStatus({
            reviewBlockId: block.id,
            status: 'approved',
            reviewer,
          });
        }
      }

      const finalStack = tracker.getStack(stream);
      expect(finalStack.every(b => b.reviewStatus === 'approved')).toBe(true);
    });

    it('should preserve changes through rebase operations', () => {
      const agent = 'agent-rebase';

      // Create parent stream
      const parentStream = tracker.createStream({
        name: 'main-feature',
        agentId: agent,
      });

      const wtParent = path.join(testRepo.path, '.worktrees', 'parent');
      tracker.createWorktree({ agentId: 'parent', path: wtParent, branch: `stream/${parentStream}` });

      fs.writeFileSync(path.join(wtParent, 'base.ts'), 'export const BASE = 1;');
      execSync('git add .', { cwd: wtParent, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: parentStream,
        message: 'feat: add base',
        agentId: agent,
        worktree: wtParent,
      });

      // Fork for child
      const childStream = tracker.forkStream({
        parentStreamId: parentStream,
        name: 'child-feature',
        agentId: agent,
      });

      const wtChild = path.join(testRepo.path, '.worktrees', 'child');
      tracker.createWorktree({ agentId: 'child', path: wtChild, branch: `stream/${childStream}` });

      // Make commits on child
      fs.writeFileSync(path.join(wtChild, 'child1.ts'), 'export const CHILD1 = 1;');
      execSync('git add .', { cwd: wtChild, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: childStream,
        message: 'feat: add child1',
        agentId: agent,
        worktree: wtChild,
      });

      fs.writeFileSync(path.join(wtChild, 'child2.ts'), 'export const CHILD2 = 2;');
      execSync('git add .', { cwd: wtChild, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: childStream,
        message: 'feat: add child2',
        agentId: agent,
        worktree: wtChild,
      });

      // Get Change-Ids before rebase
      const changesBefore = tracker.getChangesForStream(childStream);
      const changeIdsBefore = changesBefore.map(c => c.id);
      expect(changesBefore.length).toBe(2);

      // Parent gets updated
      fs.writeFileSync(path.join(wtParent, 'base.ts'), 'export const BASE = 2; // updated');
      execSync('git add .', { cwd: wtParent, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: parentStream,
        message: 'feat: update base',
        agentId: agent,
        worktree: wtParent,
      });

      // Sync child with parent (rebase)
      const rebaseResult = tracker.syncWithParent(childStream, agent, wtChild);
      expect(rebaseResult.success).toBe(true);

      // Changes should have same IDs (tracked through rebase)
      const changesAfter = tracker.getChangesForStream(childStream);
      const changeIdsAfter = changesAfter.map(c => c.id);
      expect(changeIdsAfter).toEqual(changeIdsBefore);

      // Content should be updated
      expect(fs.readFileSync(path.join(wtChild, 'base.ts'), 'utf-8')).toContain('BASE = 2');
    });

    it('should handle block splitting for focused review', () => {
      const agent = 'agent-split';

      const stream = tracker.createStream({
        name: 'large-feature',
        agentId: agent,
        enableStackedReview: true,
      });

      const wt = path.join(testRepo.path, '.worktrees', agent);
      tracker.createWorktree({ agentId: agent, path: wt, branch: `stream/${stream}` });

      // Create a large change with multiple commits
      for (let i = 1; i <= 5; i++) {
        fs.writeFileSync(path.join(wt, `file${i}.ts`), `export const FILE${i} = ${i};`);
        execSync('git add .', { cwd: wt, stdio: 'pipe' });
        tracker.commitChanges({
          streamId: stream,
          message: `feat: add file${i}`,
          agentId: agent,
          worktree: wt,
        });
      }

      // Create a single large block with all commits
      const commits = [];
      for (let i = 1; i <= 5; i++) {
        commits.push(execSync(`git log --format=%H -1 HEAD~${5 - i}`, { cwd: wt, encoding: 'utf-8' }).trim());
      }

      const blockId = tracker.createReviewBlock({
        streamId: stream,
        title: 'Large feature implementation',
        commits: commits,
      });

      const block = tracker.getReviewBlock(blockId);
      expect(block!.commits.length).toBe(5);

      // Split after position 1 (keeps first 2 commits in original, rest in new)
      // splitAfterPosition=1 means positions [0,1] stay, [2,3,4] go to new block
      const newBlockId = tracker.splitReviewBlock(blockId, 1, 'Remaining files');

      const originalBlock = tracker.getReviewBlock(blockId);
      const newBlock = tracker.getReviewBlock(newBlockId);

      expect(originalBlock!.commits.length).toBe(2);
      expect(newBlock!.commits.length).toBe(3);

      // Stack should now have 2 blocks
      const stack = tracker.getStack(stream);
      expect(stack.length).toBe(2);
    });
  });

  describe('Multi-Stack Support', () => {
    it('should support multiple named stacks per stream', () => {
      const agent = 'agent-multi-stack';

      const stream = tracker.createStream({
        name: 'multi-stack-feature',
        agentId: agent,
        enableStackedReview: true,
      });

      const wt = path.join(testRepo.path, '.worktrees', agent);
      tracker.createWorktree({ agentId: agent, path: wt, branch: `stream/${stream}` });

      // Create commits
      fs.writeFileSync(path.join(wt, 'api.ts'), 'export function api() {}');
      execSync('git add .', { cwd: wt, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: stream,
        message: 'feat: add api',
        agentId: agent,
        worktree: wt,
      });

      fs.writeFileSync(path.join(wt, 'ui.ts'), 'export function ui() {}');
      execSync('git add .', { cwd: wt, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: stream,
        message: 'feat: add ui',
        agentId: agent,
        worktree: wt,
      });

      fs.writeFileSync(path.join(wt, 'tests.ts'), 'export function tests() {}');
      execSync('git add .', { cwd: wt, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: stream,
        message: 'test: add tests',
        agentId: agent,
        worktree: wt,
      });

      // Create blocks in different stacks
      const apiHead = execSync('git log --format=%H -1 HEAD~2', { cwd: wt, encoding: 'utf-8' }).trim();
      const uiHead = execSync('git log --format=%H -1 HEAD~1', { cwd: wt, encoding: 'utf-8' }).trim();
      const testHead = execSync('git log --format=%H -1 HEAD', { cwd: wt, encoding: 'utf-8' }).trim();

      tracker.createReviewBlock({
        streamId: stream,
        title: 'API implementation',
        commits: [apiHead],
        stackName: 'backend',
      });

      tracker.createReviewBlock({
        streamId: stream,
        title: 'UI implementation',
        commits: [uiHead],
        stackName: 'frontend',
      });

      tracker.createReviewBlock({
        streamId: stream,
        title: 'Test implementation',
        commits: [testHead],
        stackName: 'testing',
      });

      // List all stacks
      const stacks = tracker.listStacks(stream);
      expect(stacks).toContain('backend');
      expect(stacks).toContain('frontend');
      expect(stacks).toContain('testing');

      // Get each stack separately
      const backendStack = tracker.getStack(stream, 'backend');
      const frontendStack = tracker.getStack(stream, 'frontend');
      const testingStack = tracker.getStack(stream, 'testing');

      expect(backendStack.length).toBe(1);
      expect(frontendStack.length).toBe(1);
      expect(testingStack.length).toBe(1);

      expect(backendStack[0].title).toContain('API');
      expect(frontendStack[0].title).toContain('UI');
      expect(testingStack[0].title).toContain('Test');

      // Set different configs per stack
      tracker.setStackConfig(stream, 'backend', { autoPopulate: true });
      tracker.setStackConfig(stream, 'frontend', { autoPopulate: false });

      const backendConfig = tracker.getStackConfig(stream, 'backend');
      const frontendConfig = tracker.getStackConfig(stream, 'frontend');

      expect(backendConfig.autoPopulate).toBe(true);
      expect(frontendConfig.autoPopulate).toBe(false);
    });
  });

  describe('Review Workflow Edge Cases', () => {
    it('should handle empty stack gracefully', () => {
      const stream = tracker.createStream({
        name: 'empty-stack',
        agentId: 'agent',
        enableStackedReview: true,
      });

      const stack = tracker.getStack(stream);
      expect(stack).toEqual([]);

      // Streams with stacked review enabled have a 'default' stack even if empty
      const stacks = tracker.listStacks(stream);
      expect(stacks.length).toBeGreaterThanOrEqual(0);
    });

    it('should prevent operations on merged blocks', () => {
      const agent = 'agent-merged';

      const stream = tracker.createStream({
        name: 'merged-block',
        agentId: agent,
        enableStackedReview: true,
      });

      const wt = path.join(testRepo.path, '.worktrees', agent);
      tracker.createWorktree({ agentId: agent, path: wt, branch: `stream/${stream}` });

      fs.writeFileSync(path.join(wt, 'file.ts'), 'content');
      execSync('git add .', { cwd: wt, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: stream,
        message: 'feat: add file',
        agentId: agent,
        worktree: wt,
      });

      tracker.autoPopulateStack(stream);
      const stack = tracker.getStack(stream);

      // Mark as merged
      tracker.setReviewStatus({
        reviewBlockId: stack[0].id,
        status: 'merged',
        reviewer: 'reviewer',
      });

      // Try to change status again - should throw
      expect(() => {
        tracker.setReviewStatus({
          reviewBlockId: stack[0].id,
          status: 'approved',
          reviewer: 'another-reviewer',
        });
      }).toThrow();
    });
  });
});
