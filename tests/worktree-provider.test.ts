/**
 * Tests for worktree provider functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createTestRepo } from './setup.js';
import { createWorktreeProvider } from '../src/worktrees.js';
import { WorktreeError } from '../src/errors.js';
import * as git from '../src/git/index.js';
import { MultiAgentRepoTracker } from '../src/tracker.js';

describe('Worktree Provider', () => {
  let testRepo: ReturnType<typeof createTestRepo>;
  let tracker: MultiAgentRepoTracker;
  let streamId1: string;
  let streamId2: string;

  beforeEach(() => {
    testRepo = createTestRepo();
    tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });

    // Create streams for testing (which also creates the stream branches)
    streamId1 = tracker.createStream({ name: 'test-stream', agentId: 'agent-1' });
    streamId2 = tracker.createStream({ name: 'another-stream', agentId: 'agent-1' });
  });

  afterEach(() => {
    tracker.close();
    testRepo.cleanup();
  });

  describe('Callback Mode', () => {
    it('should use provided callback to get worktree paths', () => {
      const worktreePaths: Record<string, string> = {
        [streamId1]: '/path/to/wt1',
        [streamId2]: '/path/to/wt2',
      };

      const provider = createWorktreeProvider(tracker.db, testRepo.path, {
        mode: 'callback',
        provider: (streamId) => worktreePaths[streamId] ?? '/default',
      });

      expect(provider.getWorktree(streamId1)).toBe('/path/to/wt1');
      expect(provider.getWorktree(streamId2)).toBe('/path/to/wt2');
      expect(provider.getWorktree('unknown')).toBe('/default');

      // Cleanup does nothing
      provider.cleanup();
    });

    it('should throw error if no provider function given', () => {
      expect(() =>
        createWorktreeProvider(tracker.db, testRepo.path, {
          mode: 'callback',
          // Missing provider function
        })
      ).toThrow(WorktreeError);
    });
  });

  describe('Temporary Mode', () => {
    it('should create temporary worktrees for each stream', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-'));

      const provider = createWorktreeProvider(tracker.db, testRepo.path, {
        mode: 'temporary',
        tempDir,
      });

      try {
        const wt1 = provider.getWorktree(streamId1);
        expect(wt1).toContain(tempDir);
        expect(wt1).toContain(streamId1);
        expect(fs.existsSync(wt1)).toBe(true);

        // Check the worktree is on the correct branch
        const branch = git.git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt1 }).trim();
        expect(branch).toBe(`stream/${streamId1}`);

        const wt2 = provider.getWorktree(streamId2);
        expect(wt2).not.toBe(wt1);
        expect(fs.existsSync(wt2)).toBe(true);

        // Cleanup should remove both worktrees
        provider.cleanup();

        // Directories should be gone
        expect(fs.existsSync(wt1)).toBe(false);
        expect(fs.existsSync(wt2)).toBe(false);
      } finally {
        // Ensure cleanup even if test fails
        try {
          provider.cleanup();
        } catch {
          // Ignore
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should use system temp dir if no tempDir specified', () => {
      const provider = createWorktreeProvider(tracker.db, testRepo.path, {
        mode: 'temporary',
      });

      let wtPath: string | undefined;
      try {
        wtPath = provider.getWorktree(streamId1);
        expect(wtPath).toContain('cascade-wt-');
        expect(fs.existsSync(wtPath)).toBe(true);
      } finally {
        provider.cleanup();
        if (wtPath && fs.existsSync(wtPath)) {
          fs.rmSync(wtPath, { recursive: true, force: true });
        }
      }
    });
  });

  describe('Sequential Mode', () => {
    it('should reuse single worktree and checkout each stream', () => {
      // Create a worktree to use for sequential mode
      const wtPath = path.join(os.tmpdir(), `seq-wt-${Date.now()}`);
      const head = git.getHead({ cwd: testRepo.path });
      git.addWorktreeDetached(wtPath, head, { cwd: testRepo.path });

      try {
        const provider = createWorktreeProvider(tracker.db, testRepo.path, {
          mode: 'sequential',
          worktreePath: wtPath,
        });

        // Get worktree for first stream
        const wt1 = provider.getWorktree(streamId1);
        expect(wt1).toBe(wtPath);
        expect(git.git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt1 }).trim()).toBe(`stream/${streamId1}`);

        // Get worktree for second stream - same path, different branch
        const wt2 = provider.getWorktree(streamId2);
        expect(wt2).toBe(wtPath);
        expect(git.git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt2 }).trim()).toBe(`stream/${streamId2}`);

        // Cleanup does nothing (caller manages worktree)
        provider.cleanup();
        expect(fs.existsSync(wtPath)).toBe(true);
      } finally {
        // Clean up the worktree
        git.removeWorktree(wtPath, true, { cwd: testRepo.path });
        if (fs.existsSync(wtPath)) {
          fs.rmSync(wtPath, { recursive: true, force: true });
        }
      }
    });

    it('should throw error if no worktreePath given', () => {
      expect(() =>
        createWorktreeProvider(tracker.db, testRepo.path, {
          mode: 'sequential',
          // Missing worktreePath
        })
      ).toThrow(WorktreeError);
    });
  });

  describe('Unknown Mode', () => {
    it('should throw error for unknown mode', () => {
      expect(() =>
        createWorktreeProvider(tracker.db, testRepo.path, {
          mode: 'unknown' as 'callback',
        })
      ).toThrow(WorktreeError);
    });
  });
});
