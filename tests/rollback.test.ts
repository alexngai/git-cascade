/**
 * Rollback operations tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { MultiAgentRepoTracker } from '../src/index.js';
import { createTestRepo, type TestRepo } from './setup.js';
import * as git from '../src/git/index.js';

describe('Rollback Operations', () => {
  let testRepo: TestRepo;
  let tracker: MultiAgentRepoTracker;
  let worktreePath: string;

  beforeEach(() => {
    testRepo = createTestRepo();
    tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });
    worktreePath = path.join(testRepo.path, '.worktrees', 'agent-1');
  });

  afterEach(() => {
    // Deallocate worktrees
    const worktrees = tracker.listWorktrees();
    for (const wt of worktrees) {
      try {
        tracker.deallocateWorktree(wt.agentId);
      } catch {
        // Ignore cleanup errors
      }
    }
    tracker.close();
    testRepo.cleanup();
  });

  describe('rollbackToOperation', () => {
    it('should rollback stream to a specific operation state', () => {
      // Create stream and worktree
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      tracker.createWorktree({
        agentId: 'agent-1',
        path: worktreePath,
        branch: `stream/${streamId}`,
      });

      // Make first commit
      fs.writeFileSync(path.join(worktreePath, 'file1.txt'), 'content 1');
      git.stageAll({ cwd: worktreePath });
      const commit1 = git.commit('First commit', { cwd: worktreePath });

      const op1 = tracker.recordOperation({
        streamId,
        agentId: 'agent-1',
        opType: 'commit',
        beforeState: commit1,
        afterState: commit1,
      });

      // Make second commit
      fs.writeFileSync(path.join(worktreePath, 'file2.txt'), 'content 2');
      git.stageAll({ cwd: worktreePath });
      const commit2 = git.commit('Second commit', { cwd: worktreePath });

      tracker.recordOperation({
        streamId,
        agentId: 'agent-1',
        opType: 'commit',
        beforeState: commit1,
        afterState: commit2,
        parentOps: [op1],
      });

      // Verify we're at commit2
      const headBefore = git.getHead({ cwd: worktreePath });
      expect(headBefore).toBe(commit2);
      expect(fs.existsSync(path.join(worktreePath, 'file2.txt'))).toBe(true);

      // Rollback to operation 1
      tracker.rollbackToOperation({
        streamId,
        operationId: op1,
        worktreePath,
      });

      // Verify we're back at commit1
      const headAfter = git.getHead({ cwd: worktreePath });
      expect(headAfter).toBe(commit1);
      expect(fs.existsSync(path.join(worktreePath, 'file1.txt'))).toBe(true);
      expect(fs.existsSync(path.join(worktreePath, 'file2.txt'))).toBe(false);

      // Verify rollback operation was recorded
      const latestOp = tracker.getLatestOperation(streamId);
      expect(latestOp?.opType).toBe('rollback');
      expect(latestOp?.afterState).toBe(commit1);
    });

    it('should reject rollback with uncommitted changes', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      tracker.createWorktree({
        agentId: 'agent-1',
        path: worktreePath,
        branch: `stream/${streamId}`,
      });

      // Make a commit
      fs.writeFileSync(path.join(worktreePath, 'file1.txt'), 'content 1');
      git.stageAll({ cwd: worktreePath });
      const commit1 = git.commit('First commit', { cwd: worktreePath });

      const op1 = tracker.recordOperation({
        streamId,
        agentId: 'agent-1',
        opType: 'commit',
        beforeState: commit1,
        afterState: commit1,
      });

      // Create uncommitted changes
      fs.writeFileSync(path.join(worktreePath, 'dirty.txt'), 'dirty');

      // Attempt rollback should fail
      expect(() => {
        tracker.rollbackToOperation({
          streamId,
          operationId: op1,
          worktreePath,
        });
      }).toThrow(/uncommitted changes/i);
    });

    it('should reject rollback to non-existent operation', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      tracker.createWorktree({
        agentId: 'agent-1',
        path: worktreePath,
        branch: `stream/${streamId}`,
      });

      expect(() => {
        tracker.rollbackToOperation({
          streamId,
          operationId: 'non-existent',
          worktreePath,
        });
      }).toThrow(/not found/i);
    });

    it('should reject rollback to operation from different stream', () => {
      const stream1 = tracker.createStream({
        name: 'stream-1',
        agentId: 'agent-1',
      });
      const stream2 = tracker.createStream({
        name: 'stream-2',
        agentId: 'agent-1',
      });

      tracker.createWorktree({
        agentId: 'agent-1',
        path: worktreePath,
        branch: `stream/${stream1}`,
      });

      // Make commit in stream1
      fs.writeFileSync(path.join(worktreePath, 'file1.txt'), 'content 1');
      git.stageAll({ cwd: worktreePath });
      const commit1 = git.commit('First commit', { cwd: worktreePath });

      const op1 = tracker.recordOperation({
        streamId: stream1,
        agentId: 'agent-1',
        opType: 'commit',
        beforeState: commit1,
        afterState: commit1,
      });

      // Try to rollback stream2 to stream1's operation
      expect(() => {
        tracker.rollbackToOperation({
          streamId: stream2,
          operationId: op1,
          worktreePath,
        });
      }).toThrow(/belongs to stream/i);
    });
  });

  describe('rollbackN', () => {
    it('should rollback N operations', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      tracker.createWorktree({
        agentId: 'agent-1',
        path: worktreePath,
        branch: `stream/${streamId}`,
      });

      // Make 3 commits
      const commits: string[] = [];
      const ops: string[] = [];

      for (let i = 1; i <= 3; i++) {
        fs.writeFileSync(
          path.join(worktreePath, `file${i}.txt`),
          `content ${i}`
        );
        git.stageAll({ cwd: worktreePath });
        const commit = git.commit(`Commit ${i}`, { cwd: worktreePath });
        commits.push(commit);

        const op = tracker.recordOperation({
          streamId,
          agentId: 'agent-1',
          opType: 'commit',
          beforeState: commits[i - 2] ?? commit,
          afterState: commit,
          parentOps: ops[i - 2] ? [ops[i - 2]!] : undefined,
        });
        ops.push(op);
      }

      // Verify we're at commit3
      expect(git.getHead({ cwd: worktreePath })).toBe(commits[2]);
      expect(fs.existsSync(path.join(worktreePath, 'file3.txt'))).toBe(true);

      // Rollback 2 operations
      tracker.rollbackN({
        streamId,
        n: 2,
        worktreePath,
      });

      // Verify we're at commit1
      expect(git.getHead({ cwd: worktreePath })).toBe(commits[0]);
      expect(fs.existsSync(path.join(worktreePath, 'file1.txt'))).toBe(true);
      expect(fs.existsSync(path.join(worktreePath, 'file2.txt'))).toBe(false);
      expect(fs.existsSync(path.join(worktreePath, 'file3.txt'))).toBe(false);
    });

    it('should reject rollback beyond available operations', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      tracker.createWorktree({
        agentId: 'agent-1',
        path: worktreePath,
        branch: `stream/${streamId}`,
      });

      // Make 1 commit
      fs.writeFileSync(path.join(worktreePath, 'file1.txt'), 'content 1');
      git.stageAll({ cwd: worktreePath });
      const commit1 = git.commit('First commit', { cwd: worktreePath });

      tracker.recordOperation({
        streamId,
        agentId: 'agent-1',
        opType: 'commit',
        beforeState: commit1,
        afterState: commit1,
      });

      // Try to rollback 2 operations (only 1 exists)
      expect(() => {
        tracker.rollbackN({
          streamId,
          n: 2,
          worktreePath,
        });
      }).toThrow(/only 1 operations in history/i);
    });

    it('should reject rollback with n <= 0', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      expect(() => {
        tracker.rollbackN({
          streamId,
          n: 0,
          worktreePath,
        });
      }).toThrow(/must be positive/i);

      expect(() => {
        tracker.rollbackN({
          streamId,
          n: -1,
          worktreePath,
        });
      }).toThrow(/must be positive/i);
    });
  });

  describe('rollbackToForkPoint', () => {
    it('should reset stream to its baseCommit', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      const stream = tracker.getStream(streamId);
      const baseCommit = stream!.baseCommit;

      tracker.createWorktree({
        agentId: 'agent-1',
        path: worktreePath,
        branch: `stream/${streamId}`,
      });

      // Make several commits
      for (let i = 1; i <= 3; i++) {
        fs.writeFileSync(
          path.join(worktreePath, `file${i}.txt`),
          `content ${i}`
        );
        git.stageAll({ cwd: worktreePath });
        git.commit(`Commit ${i}`, { cwd: worktreePath });
      }

      // Verify we have new commits
      const headBefore = git.getHead({ cwd: worktreePath });
      expect(headBefore).not.toBe(baseCommit);

      // Rollback to fork point
      tracker.rollbackToForkPoint({
        streamId,
        worktreePath,
      });

      // Verify we're back at baseCommit
      const headAfter = git.getHead({ cwd: worktreePath });
      expect(headAfter).toBe(baseCommit);
      expect(fs.existsSync(path.join(worktreePath, 'file1.txt'))).toBe(false);
      expect(fs.existsSync(path.join(worktreePath, 'file2.txt'))).toBe(false);
      expect(fs.existsSync(path.join(worktreePath, 'file3.txt'))).toBe(false);

      // Verify rollback operation was recorded
      const latestOp = tracker.getLatestOperation(streamId);
      expect(latestOp?.opType).toBe('rollback');
      expect(latestOp?.afterState).toBe(baseCommit);
      expect(latestOp?.metadata).toMatchObject({ resetToForkPoint: true });
    });

    it('should reject rollback with uncommitted changes', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      tracker.createWorktree({
        agentId: 'agent-1',
        path: worktreePath,
        branch: `stream/${streamId}`,
      });

      // Create uncommitted changes
      fs.writeFileSync(path.join(worktreePath, 'dirty.txt'), 'dirty');

      expect(() => {
        tracker.rollbackToForkPoint({
          streamId,
          worktreePath,
        });
      }).toThrow(/uncommitted changes/i);
    });
  });
});
