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

describe('Worktree Provider', () => {
  let testRepo: ReturnType<typeof createTestRepo>;

  beforeEach(() => {
    testRepo = createTestRepo();

    // Create stream branches for testing
    const head = git.getHead({ cwd: testRepo.path });
    git.createBranch('stream/test-stream', head, { cwd: testRepo.path });
    git.createBranch('stream/another-stream', head, { cwd: testRepo.path });
  });

  afterEach(() => {
    testRepo.cleanup();
  });

  describe('Callback Mode', () => {
    it('should use provided callback to get worktree paths', () => {
      const worktreePaths: Record<string, string> = {
        'test-stream': '/path/to/wt1',
        'another-stream': '/path/to/wt2',
      };

      const provider = createWorktreeProvider(testRepo.path, {
        mode: 'callback',
        provider: (streamId) => worktreePaths[streamId] ?? '/default',
      });

      expect(provider.getWorktree('test-stream')).toBe('/path/to/wt1');
      expect(provider.getWorktree('another-stream')).toBe('/path/to/wt2');
      expect(provider.getWorktree('unknown')).toBe('/default');

      // Cleanup does nothing
      provider.cleanup();
    });

    it('should throw error if no provider function given', () => {
      expect(() =>
        createWorktreeProvider(testRepo.path, {
          mode: 'callback',
          // Missing provider function
        })
      ).toThrow(WorktreeError);
    });
  });

  describe('Temporary Mode', () => {
    it('should create temporary worktrees for each stream', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-'));

      const provider = createWorktreeProvider(testRepo.path, {
        mode: 'temporary',
        tempDir,
      });

      try {
        const wt1 = provider.getWorktree('test-stream');
        expect(wt1).toContain(tempDir);
        expect(wt1).toContain('test-stream');
        expect(fs.existsSync(wt1)).toBe(true);

        // Check the worktree is on the correct branch
        const branch = git.git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt1 }).trim();
        expect(branch).toBe('stream/test-stream');

        const wt2 = provider.getWorktree('another-stream');
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
      const provider = createWorktreeProvider(testRepo.path, {
        mode: 'temporary',
      });

      let wtPath: string | undefined;
      try {
        wtPath = provider.getWorktree('test-stream');
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
        const provider = createWorktreeProvider(testRepo.path, {
          mode: 'sequential',
          worktreePath: wtPath,
        });

        // Get worktree for first stream
        const wt1 = provider.getWorktree('test-stream');
        expect(wt1).toBe(wtPath);
        expect(git.git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt1 }).trim()).toBe('stream/test-stream');

        // Get worktree for second stream - same path, different branch
        const wt2 = provider.getWorktree('another-stream');
        expect(wt2).toBe(wtPath);
        expect(git.git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt2 }).trim()).toBe('stream/another-stream');

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
        createWorktreeProvider(testRepo.path, {
          mode: 'sequential',
          // Missing worktreePath
        })
      ).toThrow(WorktreeError);
    });
  });

  describe('Unknown Mode', () => {
    it('should throw error for unknown mode', () => {
      expect(() =>
        createWorktreeProvider(testRepo.path, {
          mode: 'unknown' as 'callback',
        })
      ).toThrow(WorktreeError);
    });
  });
});
