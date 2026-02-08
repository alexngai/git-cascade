/**
 * Tests for reconciliation API (detecting and handling external git changes).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createTestRepo } from './setup.js';
import { MultiAgentRepoTracker } from '../src/tracker.js';
import * as git from '../src/git/index.js';
import { DesyncError } from '../src/errors.js';

describe('Reconciliation', () => {
  let testRepo: ReturnType<typeof createTestRepo>;
  let tracker: MultiAgentRepoTracker;

  beforeEach(() => {
    testRepo = createTestRepo();
    tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });
  });

  afterEach(() => {
    tracker.close();
    testRepo.cleanup();
  });

  describe('checkStreamSync', () => {
    it('should report in-sync for newly created stream', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      const status = tracker.checkStreamSync(streamId);

      expect(status.inSync).toBe(true);
      expect(status.streamId).toBe(streamId);
      expect(status.name).toBe('test-stream');
      expect(status.discrepancy).toBeUndefined();
    });

    it('should report out-of-sync when external commit is made', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      // Make an external commit directly to the branch (bypassing git-cascade)
      const branchName = `stream/${streamId}`;
      git.checkout(branchName, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'external.txt'), 'external change');
      git.stageAll({ cwd: testRepo.path });
      git.commit('External commit', { cwd: testRepo.path });
      git.checkout('main', { cwd: testRepo.path });

      const status = tracker.checkStreamSync(streamId);

      expect(status.inSync).toBe(false);
      expect(status.discrepancy).toBeDefined();
      expect(status.actualHead).not.toBe(status.expectedHead);
    });

    it('should report missing when branch is deleted', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      // Delete the branch externally
      const branchName = `stream/${streamId}`;
      git.deleteBranch(branchName, true, { cwd: testRepo.path });

      const status = tracker.checkStreamSync(streamId);

      expect(status.inSync).toBe(false);
      expect(status.actualHead).toBeNull();
      expect(status.discrepancy).toContain('does not exist');
    });

    it('should handle non-existent stream', () => {
      const status = tracker.checkStreamSync('non-existent');

      expect(status.inSync).toBe(false);
      expect(status.discrepancy).toContain('not found');
    });
  });

  describe('checkAllStreamsSync', () => {
    it('should check multiple streams', () => {
      const stream1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const stream2 = tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });

      const result = tracker.checkAllStreamsSync();

      expect(result.allInSync).toBe(true);
      expect(result.streams).toHaveLength(2);
      expect(result.synced).toContain(stream1);
      expect(result.synced).toContain(stream2);
      expect(result.diverged).toHaveLength(0);
      expect(result.missing).toHaveLength(0);
    });

    it('should filter by specific stream IDs', () => {
      const stream1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });
      const stream3 = tracker.createStream({ name: 'stream-3', agentId: 'agent-1' });

      const result = tracker.checkAllStreamsSync({ streamIds: [stream1, stream3] });

      expect(result.streams).toHaveLength(2);
      expect(result.streams.map((s) => s.streamId)).toContain(stream1);
      expect(result.streams.map((s) => s.streamId)).toContain(stream3);
    });

    it('should categorize diverged and missing streams', () => {
      const stream1 = tracker.createStream({ name: 'in-sync', agentId: 'agent-1' });
      const stream2 = tracker.createStream({ name: 'diverged', agentId: 'agent-1' });
      const stream3 = tracker.createStream({ name: 'missing', agentId: 'agent-1' });

      // Make external commit on stream2
      git.checkout(`stream/${stream2}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'external.txt'), 'change');
      git.stageAll({ cwd: testRepo.path });
      git.commit('External', { cwd: testRepo.path });
      git.checkout('main', { cwd: testRepo.path });

      // Delete stream3's branch
      git.deleteBranch(`stream/${stream3}`, true, { cwd: testRepo.path });

      const result = tracker.checkAllStreamsSync();

      expect(result.allInSync).toBe(false);
      expect(result.synced).toContain(stream1);
      expect(result.diverged).toContain(stream2);
      expect(result.missing).toContain(stream3);
    });
  });

  describe('reconcile', () => {
    it('should do nothing by default (dry run)', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });

      // Make external commit
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'external.txt'), 'change');
      git.stageAll({ cwd: testRepo.path });
      git.commit('External', { cwd: testRepo.path });
      git.checkout('main', { cwd: testRepo.path });

      const result = tracker.reconcile();

      // Nothing should be updated without updateDatabase: true
      expect(result.updated).toHaveLength(0);
      expect(result.branchesCreated).toHaveLength(0);
    });

    it('should update database when updateDatabase is true', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });

      // Make external commit
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'external.txt'), 'change');
      git.stageAll({ cwd: testRepo.path });
      git.commit('External', { cwd: testRepo.path });
      const newHead = git.getHead({ cwd: testRepo.path });
      git.checkout('main', { cwd: testRepo.path });

      // Verify out of sync before reconcile
      expect(tracker.checkStreamSync(streamId).inSync).toBe(false);

      const result = tracker.reconcile({ updateDatabase: true });

      expect(result.updated).toContain(streamId);

      // Verify in sync after reconcile
      expect(tracker.checkStreamSync(streamId).inSync).toBe(true);

      // Verify a reconcile operation was recorded
      const ops = tracker.getOperations({ streamId });
      const reconcileOp = ops.find((op) => op.opType === 'reconcile');
      expect(reconcileOp).toBeDefined();
      expect(reconcileOp!.afterState).toBe(newHead);
    });

    it('should create missing branches when createMissingBranches is true', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });

      // Delete the branch
      git.deleteBranch(`stream/${streamId}`, true, { cwd: testRepo.path });

      // Verify missing
      expect(tracker.checkStreamSync(streamId).actualHead).toBeNull();

      const result = tracker.reconcile({ createMissingBranches: true });

      expect(result.branchesCreated).toContain(streamId);

      // Verify branch exists now
      const branchHead = git.resolveRef(`stream/${streamId}`, { cwd: testRepo.path });
      expect(branchHead).toBeDefined();
    });

    it('should not create branch for local mode streams', () => {
      const head = git.getHead({ cwd: testRepo.path });
      git.createBranch('feature/local', head, { cwd: testRepo.path });

      const streamId = tracker.createStream({
        name: 'local-stream',
        agentId: 'agent-1',
        existingBranch: 'feature/local',
        createBranch: false,
      });

      // Delete the existing branch (simulating external deletion)
      git.deleteBranch('feature/local', true, { cwd: testRepo.path });

      const result = tracker.reconcile({ createMissingBranches: true });

      // Should fail because we can't create branches for local mode
      expect(result.failed.some((f) => f.streamId === streamId)).toBe(true);
    });

    it('should filter by streamIds', () => {
      const stream1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const stream2 = tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });

      // Make external commits on both
      for (const id of [stream1, stream2]) {
        git.checkout(`stream/${id}`, { cwd: testRepo.path });
        fs.writeFileSync(path.join(testRepo.path, `${id}.txt`), 'change');
        git.stageAll({ cwd: testRepo.path });
        git.commit('External', { cwd: testRepo.path });
      }
      git.checkout('main', { cwd: testRepo.path });

      const result = tracker.reconcile({
        updateDatabase: true,
        streamIds: [stream1],
      });

      expect(result.updated).toContain(stream1);
      expect(result.updated).not.toContain(stream2);
    });
  });

  describe('ensureStreamInSync', () => {
    it('should not throw for in-sync stream', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });

      expect(() => {
        tracker.ensureStreamInSync(streamId);
      }).not.toThrow();
    });

    it('should throw DesyncError for out-of-sync stream', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });

      // Make external commit
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'external.txt'), 'change');
      git.stageAll({ cwd: testRepo.path });
      git.commit('External', { cwd: testRepo.path });
      git.checkout('main', { cwd: testRepo.path });

      expect(() => {
        tracker.ensureStreamInSync(streamId);
      }).toThrow(DesyncError);
    });

    it('should not throw when force is true', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });

      // Make external commit
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'external.txt'), 'change');
      git.stageAll({ cwd: testRepo.path });
      git.commit('External', { cwd: testRepo.path });
      git.checkout('main', { cwd: testRepo.path });

      expect(() => {
        tracker.ensureStreamInSync(streamId, { force: true });
      }).not.toThrow();
    });

    it('should include useful information in DesyncError', () => {
      const streamId = tracker.createStream({ name: 'test', agentId: 'agent-1' });

      // Make external commit
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'external.txt'), 'change');
      git.stageAll({ cwd: testRepo.path });
      git.commit('External', { cwd: testRepo.path });
      git.checkout('main', { cwd: testRepo.path });

      try {
        tracker.ensureStreamInSync(streamId);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(DesyncError);
        const desyncError = error as DesyncError;
        expect(desyncError.streamId).toBe(streamId);
        expect(desyncError.dbState).toBeDefined();
        expect(desyncError.gitState).toBeDefined();
      }
    });
  });
});
