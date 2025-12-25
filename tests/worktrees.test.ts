/**
 * Worktree management tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { MultiAgentRepoTracker } from '../src/index.js';
import { createTestRepo, type TestRepo } from './setup.js';

describe('Worktree Management', () => {
  let testRepo: TestRepo;
  let tracker: MultiAgentRepoTracker;

  beforeEach(() => {
    testRepo = createTestRepo();
    tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });
  });

  afterEach(() => {
    // Deallocate any worktrees before cleanup
    const worktrees = tracker.listWorktrees();
    for (const wt of worktrees) {
      try {
        tracker.deallocateWorktree(wt.agentId);
      } catch {
        // Ignore errors during cleanup
      }
    }
    tracker.close();
    testRepo.cleanup();
  });

  describe('createWorktree', () => {
    it('should create a worktree for an agent', () => {
      const wtPath = path.join(testRepo.path, '.worktrees', 'agent-1');

      const worktree = tracker.createWorktree({
        agentId: 'agent-1',
        path: wtPath,
      });

      expect(worktree.agentId).toBe('agent-1');
      expect(worktree.path).toBe(wtPath);
      expect(worktree.currentStream).toBeNull();
      expect(worktree.createdAt).toBeGreaterThan(0);
      expect(worktree.lastActive).toBeGreaterThan(0);

      // Verify filesystem
      expect(fs.existsSync(wtPath)).toBe(true);
      expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(true);
    });

    it('should create worktree on a specific branch', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      const wtPath = path.join(testRepo.path, '.worktrees', 'agent-1');
      const worktree = tracker.createWorktree({
        agentId: 'agent-1',
        path: wtPath,
        branch: `stream/${streamId}`,
      });

      expect(worktree.currentStream).toBe(streamId);
    });

    it('should reject duplicate worktree for same agent', () => {
      const wtPath = path.join(testRepo.path, '.worktrees', 'agent-1');
      tracker.createWorktree({
        agentId: 'agent-1',
        path: wtPath,
      });

      expect(() => {
        tracker.createWorktree({
          agentId: 'agent-1',
          path: path.join(testRepo.path, '.worktrees', 'agent-1-other'),
        });
      }).toThrow(/already has a worktree/);
    });

    it('should allow different agents to have worktrees', () => {
      const wt1Path = path.join(testRepo.path, '.worktrees', 'agent-1');
      const wt2Path = path.join(testRepo.path, '.worktrees', 'agent-2');

      const wt1 = tracker.createWorktree({ agentId: 'agent-1', path: wt1Path });
      const wt2 = tracker.createWorktree({ agentId: 'agent-2', path: wt2Path });

      expect(wt1.agentId).toBe('agent-1');
      expect(wt2.agentId).toBe('agent-2');
      expect(fs.existsSync(wt1Path)).toBe(true);
      expect(fs.existsSync(wt2Path)).toBe(true);
    });
  });

  describe('getWorktree', () => {
    it('should retrieve worktree by agent ID', () => {
      const wtPath = path.join(testRepo.path, '.worktrees', 'agent-1');
      tracker.createWorktree({ agentId: 'agent-1', path: wtPath });

      const worktree = tracker.getWorktree('agent-1');
      expect(worktree).not.toBeNull();
      expect(worktree!.agentId).toBe('agent-1');
      expect(worktree!.path).toBe(wtPath);
    });

    it('should return null for unknown agent', () => {
      const worktree = tracker.getWorktree('unknown-agent');
      expect(worktree).toBeNull();
    });
  });

  describe('updateWorktreeStream', () => {
    it('should checkout a stream in the worktree', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      const wtPath = path.join(testRepo.path, '.worktrees', 'agent-1');
      tracker.createWorktree({ agentId: 'agent-1', path: wtPath });

      tracker.updateWorktreeStream('agent-1', streamId);

      const worktree = tracker.getWorktree('agent-1');
      expect(worktree!.currentStream).toBe(streamId);
    });

    it('should update lastActive timestamp', async () => {
      const wtPath = path.join(testRepo.path, '.worktrees', 'agent-1');
      const wt1 = tracker.createWorktree({ agentId: 'agent-1', path: wtPath });

      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      tracker.updateWorktreeStream('agent-1', streamId);

      const wt2 = tracker.getWorktree('agent-1');
      expect(wt2!.lastActive).toBeGreaterThan(wt1.lastActive);
    });

    it('should throw for unknown agent', () => {
      expect(() => {
        tracker.updateWorktreeStream('unknown-agent', 'some-stream');
      }).toThrow(/No worktree found/);
    });
  });

  describe('deallocateWorktree', () => {
    it('should remove worktree from filesystem and database', () => {
      const wtPath = path.join(testRepo.path, '.worktrees', 'agent-1');
      tracker.createWorktree({ agentId: 'agent-1', path: wtPath });

      expect(fs.existsSync(wtPath)).toBe(true);
      expect(tracker.getWorktree('agent-1')).not.toBeNull();

      tracker.deallocateWorktree('agent-1');

      expect(fs.existsSync(wtPath)).toBe(false);
      expect(tracker.getWorktree('agent-1')).toBeNull();
    });

    it('should be idempotent for unknown agent', () => {
      // Should not throw
      expect(() => {
        tracker.deallocateWorktree('unknown-agent');
      }).not.toThrow();
    });
  });

  describe('listWorktrees', () => {
    it('should list all registered worktrees', () => {
      const wt1Path = path.join(testRepo.path, '.worktrees', 'agent-1');
      const wt2Path = path.join(testRepo.path, '.worktrees', 'agent-2');

      tracker.createWorktree({ agentId: 'agent-1', path: wt1Path });
      tracker.createWorktree({ agentId: 'agent-2', path: wt2Path });

      const worktrees = tracker.listWorktrees();
      expect(worktrees).toHaveLength(2);
    });

    it('should return empty array when no worktrees', () => {
      const worktrees = tracker.listWorktrees();
      expect(worktrees).toHaveLength(0);
    });

    it('should reflect deallocations', () => {
      const wt1Path = path.join(testRepo.path, '.worktrees', 'agent-1');
      const wt2Path = path.join(testRepo.path, '.worktrees', 'agent-2');

      tracker.createWorktree({ agentId: 'agent-1', path: wt1Path });
      tracker.createWorktree({ agentId: 'agent-2', path: wt2Path });

      tracker.deallocateWorktree('agent-1');

      const worktrees = tracker.listWorktrees();
      expect(worktrees).toHaveLength(1);
      expect(worktrees[0]!.agentId).toBe('agent-2');
    });
  });
});
