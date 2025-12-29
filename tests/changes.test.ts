import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker } from '../src/tracker.js';
import { createTestRepo } from './setup.js';
import * as git from '../src/git/index.js';
import * as changes from '../src/changes.js';
import * as fs from 'fs';
import * as path from 'path';

describe('Change Identity Tracking', () => {
  let tracker: MultiAgentRepoTracker;
  let testRepo: ReturnType<typeof createTestRepo>;

  beforeEach(() => {
    testRepo = createTestRepo();
    tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });
  });

  afterEach(() => {
    tracker.close();
    testRepo.cleanup();
  });

  describe('Change-Id Helpers', () => {
    it('should generate valid Change-Id', () => {
      const changeId = git.generateChangeId();
      expect(changeId).toMatch(/^c-[a-f0-9]{8}$/);
    });

    it('should extract Change-Id from commit message', () => {
      const message = `feat: add feature

Some description.

Change-Id: c-abc12345`;
      const changeId = git.extractChangeId(message);
      expect(changeId).toBe('c-abc12345');
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
      expect(git.extractChangeId(result)).toMatch(/^c-[a-f0-9]{8}$/);
    });

    it('should not duplicate Change-Id if already present', () => {
      const message = `feat: add feature

Change-Id: c-existing1`;
      const result = git.ensureChangeId(message);
      expect(result).toBe(message);
      expect(git.extractChangeId(result)).toBe('c-existing1');
    });

    it('should append to existing trailer section', () => {
      const message = `feat: add feature

Signed-off-by: Test User`;
      const result = git.ensureChangeId(message);
      expect(result).toContain('Signed-off-by: Test User');
      expect(result).toContain('Change-Id: c-');
    });
  });

  describe('Change CRUD', () => {
    it('should create a change', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const filePath = path.join(testRepo.path, 'test.txt');
      fs.writeFileSync(filePath, 'content');
      git.stageAll({ cwd: testRepo.path });
      const commit = git.commit('test commit', { cwd: testRepo.path });

      const changeId = tracker.createChange({
        streamId,
        commit,
        description: 'test commit',
      });

      expect(changeId).toMatch(/^c-[a-f0-9]{8}$/);

      const change = tracker.getChange(changeId);
      expect(change).not.toBeNull();
      expect(change!.streamId).toBe(streamId);
      expect(change!.currentCommit).toBe(commit);
      expect(change!.status).toBe('active');
      expect(change!.commitHistory).toHaveLength(1);
      expect(change!.commitHistory[0].reason).toBe('initial');
    });

    it('should get change by commit', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const filePath = path.join(testRepo.path, 'test.txt');
      fs.writeFileSync(filePath, 'content');
      git.stageAll({ cwd: testRepo.path });
      const commit = git.commit('test commit', { cwd: testRepo.path });

      const changeId = tracker.createChange({
        streamId,
        commit,
        description: 'test commit',
      });

      const change = tracker.getChangeByCommit(commit);
      expect(change).not.toBeNull();
      expect(change!.id).toBe(changeId);
    });

    it('should get changes for stream', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });

      // Create first commit
      fs.writeFileSync(path.join(testRepo.path, 'file1.txt'), 'content1');
      git.stageAll({ cwd: testRepo.path });
      const commit1 = git.commit('commit 1', { cwd: testRepo.path });
      tracker.createChange({ streamId, commit: commit1, description: 'commit 1' });

      // Create second commit
      fs.writeFileSync(path.join(testRepo.path, 'file2.txt'), 'content2');
      git.stageAll({ cwd: testRepo.path });
      const commit2 = git.commit('commit 2', { cwd: testRepo.path });
      tracker.createChange({ streamId, commit: commit2, description: 'commit 2' });

      const changes = tracker.getChangesForStream(streamId);
      expect(changes).toHaveLength(2);
    });
  });

  describe('Change Lifecycle', () => {
    it('should mark change as merged', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'test.txt'), 'content');
      git.stageAll({ cwd: testRepo.path });
      const commit = git.commit('test commit', { cwd: testRepo.path });

      const changeId = tracker.createChange({
        streamId,
        commit,
        description: 'test commit',
      });

      tracker.markChangesMerged([changeId]);

      const change = tracker.getChange(changeId);
      expect(change!.status).toBe('merged');
    });

    it('should mark change as dropped', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'test.txt'), 'content');
      git.stageAll({ cwd: testRepo.path });
      const commit = git.commit('test commit', { cwd: testRepo.path });

      const changeId = tracker.createChange({
        streamId,
        commit,
        description: 'test commit',
      });

      tracker.markChangeDropped(changeId);

      const change = tracker.getChange(changeId);
      expect(change!.status).toBe('dropped');
      expect(change!.currentCommit).toBeNull();
    });

    it('should record squash', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });

      // Create two commits
      fs.writeFileSync(path.join(testRepo.path, 'file1.txt'), 'content1');
      git.stageAll({ cwd: testRepo.path });
      const commit1 = git.commit('commit 1', { cwd: testRepo.path });
      const change1 = tracker.createChange({ streamId, commit: commit1, description: 'commit 1' });

      fs.writeFileSync(path.join(testRepo.path, 'file2.txt'), 'content2');
      git.stageAll({ cwd: testRepo.path });
      const commit2 = git.commit('commit 2', { cwd: testRepo.path });
      const change2 = tracker.createChange({ streamId, commit: commit2, description: 'commit 2' });

      // Simulate squash
      const squashedCommit = 'abc123squashed';
      tracker.recordSquash([change1], change2, squashedCommit);

      // Check absorbed change
      const absorbedChange = tracker.getChange(change1);
      expect(absorbedChange!.status).toBe('squashed');
      expect(absorbedChange!.squashedInto).toBe(change2);

      // Check target change
      const targetChange = tracker.getChange(change2);
      expect(targetChange!.currentCommit).toBe(squashedCommit);
      expect(targetChange!.commitHistory).toHaveLength(2);
    });

    it('should record split', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'test.txt'), 'content');
      git.stageAll({ cwd: testRepo.path });
      const commit = git.commit('original commit', { cwd: testRepo.path });

      const originalId = tracker.createChange({
        streamId,
        commit,
        description: 'original commit',
      });

      // Simulate split
      const newIds = tracker.recordSplit(originalId, streamId, [
        { commit: 'split1hash', description: 'split part 1' },
        { commit: 'split2hash', description: 'split part 2' },
      ]);

      expect(newIds).toHaveLength(2);

      // Check original is dropped
      const original = tracker.getChange(originalId);
      expect(original!.status).toBe('dropped');

      // Check new changes exist
      for (const newId of newIds) {
        const newChange = tracker.getChange(newId);
        expect(newChange).not.toBeNull();
        expect(newChange!.splitFrom).toBe(originalId);
        expect(newChange!.status).toBe('active');
      }
    });
  });

  describe('Commit Integration', () => {
    it('should create change when using commitChanges', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'test.txt'), 'content');

      const result = tracker.commitChanges({
        streamId,
        agentId: 'agent-1',
        worktree: testRepo.path,
        message: 'test commit',
      });

      expect(result.commit).toBeTruthy();
      expect(result.changeId).toMatch(/^c-[a-f0-9]{8}$/);

      // Verify change was created
      const change = tracker.getChange(result.changeId);
      expect(change).not.toBeNull();
      expect(change!.currentCommit).toBe(result.commit);
      expect(change!.description).toBe('test commit');

      // Verify commit has Change-Id trailer
      const message = git.getCommitMessage(result.commit, { cwd: testRepo.path });
      expect(message).toContain(`Change-Id: ${result.changeId}`);
    });
  });

  describe('Historical Commit Lookup', () => {
    it('should find change by historical commit', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'test.txt'), 'content');
      git.stageAll({ cwd: testRepo.path });
      const originalCommit = git.commit('test commit', { cwd: testRepo.path });

      const changeId = tracker.createChange({
        streamId,
        commit: originalCommit,
        description: 'test commit',
      });

      // Simulate a rewrite by updating the change
      const newCommit = 'newcommithash123';
      changes.recordRewrite(tracker.db, changeId, newCommit, 'rebase');

      // Should find by original commit
      const foundByOriginal = tracker.getChangeByHistoricalCommit(originalCommit);
      expect(foundByOriginal).not.toBeNull();
      expect(foundByOriginal!.id).toBe(changeId);

      // Should find by current commit
      const foundByCurrent = tracker.getChangeByCommit(newCommit);
      expect(foundByCurrent).not.toBeNull();
      expect(foundByCurrent!.id).toBe(changeId);
    });
  });

  describe('Rebase Integration', () => {
    it('should update changes after rebase', () => {
      // Create parent stream
      const parentId = tracker.createStream({
        name: 'parent',
        agentId: 'agent-1',
      });

      // Fork child stream
      const childId = tracker.forkStream({
        parentStreamId: parentId,
        name: 'child',
        agentId: 'agent-1',
      });

      // Make commit on parent
      git.checkout(`stream/${parentId}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'parent.txt'), 'parent content');
      git.stageAll({ cwd: testRepo.path });
      git.commit('parent commit', { cwd: testRepo.path });

      // Make commit on child with change tracking
      git.checkout(`stream/${childId}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'child.txt'), 'child content');

      const result = tracker.commitChanges({
        streamId: childId,
        agentId: 'agent-1',
        worktree: testRepo.path,
        message: 'child commit',
      });

      const originalCommit = result.commit;
      const changeId = result.changeId;

      // Rebase child onto parent
      const rebaseResult = tracker.rebaseOntoStream({
        sourceStream: childId,
        targetStream: parentId,
        agentId: 'agent-1',
        worktree: testRepo.path,
      });

      expect(rebaseResult.success).toBe(true);

      // Verify change was updated
      const change = tracker.getChange(changeId);
      expect(change).not.toBeNull();
      expect(change!.currentCommit).not.toBe(originalCommit); // Should have new commit
      expect(change!.commitHistory.length).toBeGreaterThanOrEqual(2); // Original + rebase
      expect(change!.commitHistory[0].reason).toBe('rebase');
    });
  });

  describe('Merge Integration', () => {
    it('should mark changes as merged when stream is merged', () => {
      // Create parent stream
      const parentId = tracker.createStream({
        name: 'parent',
        agentId: 'agent-1',
      });

      // Fork child stream
      const childId = tracker.forkStream({
        parentStreamId: parentId,
        name: 'child',
        agentId: 'agent-1',
      });

      // Make commit on child with change tracking
      git.checkout(`stream/${childId}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'child.txt'), 'child content');

      const result = tracker.commitChanges({
        streamId: childId,
        agentId: 'agent-1',
        worktree: testRepo.path,
        message: 'child commit',
      });

      // Merge child into parent
      const mergeResult = tracker.mergeStream({
        sourceStream: childId,
        targetStream: parentId,
        worktree: testRepo.path,
      });

      expect(mergeResult.success).toBe(true);

      // Verify change was marked as merged
      const change = tracker.getChange(result.changeId);
      expect(change!.status).toBe('merged');
    });
  });
});
