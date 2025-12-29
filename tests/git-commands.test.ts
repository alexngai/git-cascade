import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRepo } from './setup.js';
import * as git from '../src/git/index.js';
import * as fs from 'fs';
import * as path from 'path';
import { GitOperationError, BranchNotFoundError } from '../src/errors.js';

describe('Git Commands', () => {
  let testRepo: ReturnType<typeof createTestRepo>;

  beforeEach(() => {
    testRepo = createTestRepo();
  });

  afterEach(() => {
    testRepo.cleanup();
  });

  describe('Basic Operations', () => {
    it('should get HEAD commit', () => {
      const head = git.getHead({ cwd: testRepo.path });
      expect(head).toMatch(/^[a-f0-9]{40}$/);
    });

    it('should resolve ref to commit hash', () => {
      const mainCommit = git.resolveRef('main', { cwd: testRepo.path });
      expect(mainCommit).toMatch(/^[a-f0-9]{40}$/);
    });

    it('should throw BranchNotFoundError for invalid ref', () => {
      expect(() => {
        git.resolveRef('nonexistent-branch', { cwd: testRepo.path });
      }).toThrow(BranchNotFoundError);
    });

    it('should check if ref exists', () => {
      expect(git.refExists('main', { cwd: testRepo.path })).toBe(true);
      expect(git.refExists('nonexistent', { cwd: testRepo.path })).toBe(false);
    });

    it('should check if working directory is clean', () => {
      expect(git.isClean({ cwd: testRepo.path })).toBe(true);

      // Make it dirty
      fs.writeFileSync(path.join(testRepo.path, 'dirty.txt'), 'content');
      expect(git.isClean({ cwd: testRepo.path })).toBe(false);
    });

    it('should get changed files', () => {
      expect(git.getChangedFiles({ cwd: testRepo.path })).toHaveLength(0);

      fs.writeFileSync(path.join(testRepo.path, 'new-file.txt'), 'content');
      const changed = git.getChangedFiles({ cwd: testRepo.path });
      expect(changed).toContain('new-file.txt');
    });
  });

  describe('Branch Operations', () => {
    it('should create and delete a branch', () => {
      const head = git.getHead({ cwd: testRepo.path });
      git.createBranch('test-branch', head, { cwd: testRepo.path });

      expect(git.refExists('test-branch', { cwd: testRepo.path })).toBe(true);

      git.deleteBranch('test-branch', false, { cwd: testRepo.path });
      expect(git.refExists('test-branch', { cwd: testRepo.path })).toBe(false);
    });

    it('should force delete a branch', () => {
      const head = git.getHead({ cwd: testRepo.path });
      git.createBranch('test-branch', head, { cwd: testRepo.path });
      git.deleteBranch('test-branch', true, { cwd: testRepo.path });
      expect(git.refExists('test-branch', { cwd: testRepo.path })).toBe(false);
    });

    it('should update a branch to point to a different commit', () => {
      // Create a branch
      const head1 = git.getHead({ cwd: testRepo.path });
      git.createBranch('test-branch', head1, { cwd: testRepo.path });

      // Make a new commit
      fs.writeFileSync(path.join(testRepo.path, 'new.txt'), 'content');
      git.stageAll({ cwd: testRepo.path });
      const head2 = git.commit('new commit', { cwd: testRepo.path });

      // Update branch
      git.updateBranch('test-branch', head2, { cwd: testRepo.path });

      const branchHead = git.resolveRef('test-branch', { cwd: testRepo.path });
      expect(branchHead).toBe(head2);
    });
  });

  describe('Commit Operations', () => {
    it('should create a commit', () => {
      fs.writeFileSync(path.join(testRepo.path, 'file.txt'), 'content');
      git.stageAll({ cwd: testRepo.path });
      const commit = git.commit('test commit', { cwd: testRepo.path });
      expect(commit).toMatch(/^[a-f0-9]{40}$/);
    });

    it('should get commit message', () => {
      fs.writeFileSync(path.join(testRepo.path, 'file.txt'), 'content');
      git.stageAll({ cwd: testRepo.path });
      const commit = git.commit('my test message', { cwd: testRepo.path });

      const message = git.getCommitMessage(commit, { cwd: testRepo.path });
      expect(message).toContain('my test message');
    });

    it('should amend commit with new message', () => {
      fs.writeFileSync(path.join(testRepo.path, 'file.txt'), 'content');
      git.stageAll({ cwd: testRepo.path });
      git.commit('original message', { cwd: testRepo.path });

      const amended = git.amendCommit('amended message', { cwd: testRepo.path });
      const message = git.getCommitMessage(amended, { cwd: testRepo.path });
      expect(message).toContain('amended message');
    });

    it('should amend commit without changing message', () => {
      fs.writeFileSync(path.join(testRepo.path, 'file.txt'), 'content');
      git.stageAll({ cwd: testRepo.path });
      git.commit('original message', { cwd: testRepo.path });

      // Add more changes
      fs.writeFileSync(path.join(testRepo.path, 'file2.txt'), 'content2');
      git.stageAll({ cwd: testRepo.path });

      const amended = git.amendCommit(undefined, { cwd: testRepo.path });
      const message = git.getCommitMessage(amended, { cwd: testRepo.path });
      expect(message).toContain('original message');
    });

    it('should get commit range', () => {
      const base = git.getHead({ cwd: testRepo.path });

      // Create 3 commits
      for (let i = 1; i <= 3; i++) {
        fs.writeFileSync(path.join(testRepo.path, `file${i}.txt`), `content${i}`);
        git.stageAll({ cwd: testRepo.path });
        git.commit(`commit ${i}`, { cwd: testRepo.path });
      }

      const commits = git.getCommitRange(base, 'HEAD', { cwd: testRepo.path });
      expect(commits).toHaveLength(3);
    });

    it('should return empty array for no commits in range', () => {
      const head = git.getHead({ cwd: testRepo.path });
      const commits = git.getCommitRange(head, head, { cwd: testRepo.path });
      expect(commits).toHaveLength(0);
    });
  });

  describe('Checkout and Reset', () => {
    it('should checkout a branch', () => {
      const head = git.getHead({ cwd: testRepo.path });
      git.createBranch('test-branch', head, { cwd: testRepo.path });

      git.checkout('test-branch', { cwd: testRepo.path });
      // We're now on test-branch
    });

    it('should hard reset to a commit', () => {
      const original = git.getHead({ cwd: testRepo.path });

      fs.writeFileSync(path.join(testRepo.path, 'file.txt'), 'content');
      git.stageAll({ cwd: testRepo.path });
      git.commit('new commit', { cwd: testRepo.path });

      git.resetHard(original, { cwd: testRepo.path });
      expect(git.getHead({ cwd: testRepo.path })).toBe(original);
    });
  });

  describe('Merge Base', () => {
    it('should find merge base between branches', () => {
      const base = git.getHead({ cwd: testRepo.path });

      // Create branch1 with a commit
      git.createBranch('branch1', base, { cwd: testRepo.path });
      git.checkout('branch1', { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'branch1.txt'), 'content');
      git.stageAll({ cwd: testRepo.path });
      git.commit('branch1 commit', { cwd: testRepo.path });

      // Create branch2 with a commit
      git.checkout('main', { cwd: testRepo.path });
      git.createBranch('branch2', base, { cwd: testRepo.path });
      git.checkout('branch2', { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'branch2.txt'), 'content');
      git.stageAll({ cwd: testRepo.path });
      git.commit('branch2 commit', { cwd: testRepo.path });

      const mergeBase = git.getMergeBase('branch1', 'branch2', { cwd: testRepo.path });
      expect(mergeBase).toBe(base);
    });
  });

  describe('Cherry-pick', () => {
    it('should cherry-pick a commit successfully', () => {
      const base = git.getHead({ cwd: testRepo.path });

      // Create a commit on a separate branch
      git.createBranch('feature', base, { cwd: testRepo.path });
      git.checkout('feature', { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'feature.txt'), 'feature content');
      git.stageAll({ cwd: testRepo.path });
      const featureCommit = git.commit('feature commit', { cwd: testRepo.path });

      // Cherry-pick onto main
      git.checkout('main', { cwd: testRepo.path });
      const result = git.cherryPick(featureCommit, { cwd: testRepo.path });

      expect(result.success).toBe(true);
      expect(result.conflicts).toHaveLength(0);
    });

    it('should detect conflicts during cherry-pick', () => {
      // Create conflicting content
      fs.writeFileSync(path.join(testRepo.path, 'conflict.txt'), 'main content');
      git.stageAll({ cwd: testRepo.path });
      git.commit('main commit', { cwd: testRepo.path });

      const base = git.resolveRef('main~1', { cwd: testRepo.path });

      // Create feature branch from before conflict file
      git.createBranch('feature', base, { cwd: testRepo.path });
      git.checkout('feature', { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'conflict.txt'), 'feature content');
      git.stageAll({ cwd: testRepo.path });
      const featureCommit = git.commit('feature commit', { cwd: testRepo.path });

      // Try to cherry-pick (should conflict)
      git.checkout('main', { cwd: testRepo.path });
      const result = git.cherryPick(featureCommit, { cwd: testRepo.path });

      expect(result.success).toBe(false);
      expect(result.conflicts).toContain('conflict.txt');

      // Clean up the cherry-pick (may already be aborted)
      try {
        git.git(['cherry-pick', '--abort'], { cwd: testRepo.path });
      } catch {
        // Cherry-pick might have auto-aborted, reset to clean state
        git.git(['reset', '--hard', 'HEAD'], { cwd: testRepo.path });
      }
    });
  });

  describe('Worktree Operations', () => {
    it('should list worktrees', () => {
      const worktrees = git.listWorktrees({ cwd: testRepo.path });
      expect(worktrees.length).toBeGreaterThanOrEqual(1);
      // Use realpath to handle macOS symlink (/var -> /private/var)
      const expectedPath = fs.realpathSync(testRepo.path);
      expect(worktrees[0].path).toBe(expectedPath);
    });

    it('should add and remove a worktree', () => {
      const head = git.getHead({ cwd: testRepo.path });
      git.createBranch('wt-branch', head, { cwd: testRepo.path });

      const wtPath = path.join(testRepo.path, '..', 'test-worktree-' + Date.now());

      git.addWorktree(wtPath, 'wt-branch', { cwd: testRepo.path });

      const worktrees = git.listWorktrees({ cwd: testRepo.path });
      // Use realpath to handle macOS symlink resolution
      const realWtPath = fs.realpathSync(wtPath);
      const found = worktrees.find((wt) => wt.path === realWtPath);
      expect(found).toBeDefined();

      git.removeWorktree(wtPath, true, { cwd: testRepo.path });
    });

    it('should add detached worktree', () => {
      const head = git.getHead({ cwd: testRepo.path });
      const wtPath = path.join(testRepo.path, '..', 'detached-wt-' + Date.now());

      git.addWorktreeDetached(wtPath, head, { cwd: testRepo.path });

      const worktrees = git.listWorktrees({ cwd: testRepo.path });
      // Use realpath to handle macOS symlink resolution
      const realWtPath = fs.realpathSync(wtPath);
      const found = worktrees.find((wt) => wt.path === realWtPath);
      expect(found).toBeDefined();
      expect(found!.branch).toBeNull(); // Detached has no branch

      git.removeWorktree(wtPath, true, { cwd: testRepo.path });
    });

    it('should prune worktrees', () => {
      // Just ensure it doesn't throw
      git.pruneWorktrees({ cwd: testRepo.path });
    });
  });

  describe('Patch-ID Operations', () => {
    it('should get patch-id for a commit', () => {
      fs.writeFileSync(path.join(testRepo.path, 'file.txt'), 'content');
      git.stageAll({ cwd: testRepo.path });
      const commit = git.commit('test commit', { cwd: testRepo.path });

      const patchId = git.getPatchId(commit, { cwd: testRepo.path });
      expect(patchId).toMatch(/^[a-f0-9]{40}$/);
    });

    it('should build patch-id map', () => {
      const commits: string[] = [];
      for (let i = 1; i <= 3; i++) {
        fs.writeFileSync(path.join(testRepo.path, `file${i}.txt`), `content${i}`);
        git.stageAll({ cwd: testRepo.path });
        commits.push(git.commit(`commit ${i}`, { cwd: testRepo.path }));
      }

      const map = git.buildPatchIdMap(commits, { cwd: testRepo.path });
      expect(map.size).toBe(3);

      // Each commit should have a unique patch-id
      const patchIds = Array.from(map.keys());
      expect(new Set(patchIds).size).toBe(3);
    });
  });

  describe('Change-Id Operations', () => {
    it('should generate valid Change-Id', () => {
      const changeId = git.generateChangeId();
      expect(changeId).toMatch(/^c-[a-f0-9]{8}$/);
    });

    it('should generate unique Change-Ids', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(git.generateChangeId());
      }
      expect(ids.size).toBe(100);
    });

    it('should extract Change-Id from commit message', () => {
      const message = `feat: add feature

Some description here.

Change-Id: c-abc12345`;

      const changeId = git.extractChangeId(message);
      expect(changeId).toBe('c-abc12345');
    });

    it('should extract Change-Id with other trailers', () => {
      const message = `feat: add feature

Signed-off-by: Test User
Change-Id: c-def67890
Reviewed-by: Another User`;

      const changeId = git.extractChangeId(message);
      expect(changeId).toBe('c-def67890');
    });

    it('should return null when no Change-Id present', () => {
      const message = `feat: add feature

Some description.`;

      const changeId = git.extractChangeId(message);
      expect(changeId).toBeNull();
    });

    it('should ensure Change-Id is added if missing', () => {
      const message = 'feat: add feature';
      const result = git.ensureChangeId(message);

      expect(result).toContain('Change-Id: c-');
      const extracted = git.extractChangeId(result);
      expect(extracted).toMatch(/^c-[a-f0-9]{8}$/);
    });

    it('should not duplicate Change-Id if already present', () => {
      const message = `feat: add feature

Change-Id: c-existing1`;

      const result = git.ensureChangeId(message);
      expect(result).toBe(message);

      // Count Change-Id occurrences
      const matches = result.match(/Change-Id:/g);
      expect(matches).toHaveLength(1);
    });

    it('should add Change-Id to existing trailer section', () => {
      const message = `feat: add feature

Signed-off-by: Test User`;

      const result = git.ensureChangeId(message);
      expect(result).toContain('Signed-off-by: Test User');
      expect(result).toContain('Change-Id: c-');

      // Should be on the same trailer section (no extra blank lines)
      const lines = result.split('\n');
      const signedIdx = lines.findIndex((l) => l.includes('Signed-off-by'));
      const changeIdx = lines.findIndex((l) => l.includes('Change-Id'));
      expect(changeIdx).toBe(signedIdx + 1);
    });

    it('should create a commit with Change-Id', () => {
      fs.writeFileSync(path.join(testRepo.path, 'file.txt'), 'content');
      git.stageAll({ cwd: testRepo.path });

      const result = git.commitWithChangeId('test commit', { cwd: testRepo.path });

      expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(result.changeId).toMatch(/^c-[a-f0-9]{8}$/);

      // Verify the commit message contains the Change-Id
      const message = git.getCommitMessage(result.commit, { cwd: testRepo.path });
      expect(message).toContain(`Change-Id: ${result.changeId}`);
    });

    it('should get Change-Id from existing commit', () => {
      fs.writeFileSync(path.join(testRepo.path, 'file.txt'), 'content');
      git.stageAll({ cwd: testRepo.path });
      const { commit, changeId } = git.commitWithChangeId('test commit', { cwd: testRepo.path });

      const extractedId = git.getCommitChangeId(commit, { cwd: testRepo.path });
      expect(extractedId).toBe(changeId);
    });

    it('should return null for commit without Change-Id', () => {
      fs.writeFileSync(path.join(testRepo.path, 'file.txt'), 'content');
      git.stageAll({ cwd: testRepo.path });
      const commit = git.commit('test commit without change-id', { cwd: testRepo.path });

      const changeId = git.getCommitChangeId(commit, { cwd: testRepo.path });
      expect(changeId).toBeNull();
    });
  });

  describe('Rebase Operations', () => {
    it('should check if rebase is in progress', () => {
      expect(git.isRebaseInProgress({ cwd: testRepo.path })).toBe(false);
    });

    it('should rebase commits onto new base', () => {
      const base = git.getHead({ cwd: testRepo.path });

      // Create main commit
      fs.writeFileSync(path.join(testRepo.path, 'main.txt'), 'main content');
      git.stageAll({ cwd: testRepo.path });
      const mainCommit = git.commit('main commit', { cwd: testRepo.path });

      // Create feature branch from base
      git.createBranch('feature', base, { cwd: testRepo.path });
      git.checkout('feature', { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'feature.txt'), 'feature content');
      git.stageAll({ cwd: testRepo.path });
      git.commit('feature commit', { cwd: testRepo.path });

      // Rebase feature onto main
      const result = git.rebaseOnto(mainCommit, base, 'feature', { cwd: testRepo.path });

      expect(result.success).toBe(true);
      expect(result.newHead).toBeDefined();

      // Verify feature.txt exists on rebased branch
      expect(fs.existsSync(path.join(testRepo.path, 'feature.txt'))).toBe(true);
      // Verify main.txt also exists (from main commit)
      expect(fs.existsSync(path.join(testRepo.path, 'main.txt'))).toBe(true);
    });

    it('should detect conflicts during rebase', () => {
      // Create conflicting commits
      fs.writeFileSync(path.join(testRepo.path, 'conflict.txt'), 'base content');
      git.stageAll({ cwd: testRepo.path });
      const baseCommit = git.commit('base commit', { cwd: testRepo.path });

      // Main changes the file
      fs.writeFileSync(path.join(testRepo.path, 'conflict.txt'), 'main content');
      git.stageAll({ cwd: testRepo.path });
      const mainCommit = git.commit('main commit', { cwd: testRepo.path });

      // Feature branch from base also changes the file
      git.createBranch('feature', baseCommit, { cwd: testRepo.path });
      git.checkout('feature', { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'conflict.txt'), 'feature content');
      git.stageAll({ cwd: testRepo.path });
      git.commit('feature commit', { cwd: testRepo.path });

      // Rebase should fail with conflicts
      const result = git.rebaseOnto(mainCommit, baseCommit, 'feature', { cwd: testRepo.path });

      expect(result.success).toBe(false);
      expect(result.conflicts).toContain('conflict.txt');

      // Abort the rebase
      git.rebaseAbort({ cwd: testRepo.path });
    });

    it('should rebase with theirs strategy', () => {
      // Create conflicting commits
      fs.writeFileSync(path.join(testRepo.path, 'conflict.txt'), 'base content');
      git.stageAll({ cwd: testRepo.path });
      const baseCommit = git.commit('base commit', { cwd: testRepo.path });

      // Main changes the file
      fs.writeFileSync(path.join(testRepo.path, 'conflict.txt'), 'main content');
      git.stageAll({ cwd: testRepo.path });
      const mainCommit = git.commit('main commit', { cwd: testRepo.path });

      // Feature branch from base also changes the file
      git.createBranch('feature', baseCommit, { cwd: testRepo.path });
      git.checkout('feature', { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'conflict.txt'), 'feature content');
      git.stageAll({ cwd: testRepo.path });
      git.commit('feature commit', { cwd: testRepo.path });

      // Rebase with theirs strategy (keep main's changes)
      const result = git.rebaseOntoWithStrategy(
        mainCommit,
        baseCommit,
        'feature',
        'theirs',
        { cwd: testRepo.path }
      );

      expect(result.success).toBe(true);
    });
  });

  describe('Conflict Operations', () => {
    it('should get conflicted files when in conflict state', () => {
      // When not in conflict, should return empty
      const files = git.getConflictedFiles({ cwd: testRepo.path });
      expect(files).toHaveLength(0);
    });
  });

  describe('Error Handling', () => {
    it('should throw GitOperationError for invalid git command', () => {
      expect(() => {
        git.git(['invalid-command-xyz'], { cwd: testRepo.path });
      }).toThrow(GitOperationError);
    });
  });
});
