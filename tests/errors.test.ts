/**
 * Tests for custom error classes.
 */

import { describe, it, expect } from 'vitest';
import {
  GitOperationError,
  ConflictError,
  BranchNotFoundError,
  WorktreeError,
  StreamNotFoundError,
  UnresolvedConflictsError,
  CyclicDependencyError,
  DiamondDependencyError,
  DesyncError,
  LockError,
} from '../src/errors.js';

describe('Error Classes', () => {
  describe('GitOperationError', () => {
    it('should create error with message', () => {
      const err = new GitOperationError('git failed');
      expect(err.message).toBe('git failed');
      expect(err.name).toBe('GitOperationError');
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('ConflictError', () => {
    it('should create error with conflict details', () => {
      const files = ['file1.txt', 'file2.txt'];
      const err = new ConflictError(files, 'rebase');

      expect(err.message).toBe('Conflict in rebase: file1.txt, file2.txt');
      expect(err.name).toBe('ConflictError');
      expect(err.conflictedFiles).toEqual(files);
      expect(err.operation).toBe('rebase');
      expect(err).toBeInstanceOf(GitOperationError);
    });

    it('should support merge operation', () => {
      const err = new ConflictError(['x.ts'], 'merge');
      expect(err.operation).toBe('merge');
      expect(err.message).toContain('merge');
    });

    it('should support cherry_pick operation', () => {
      const err = new ConflictError(['y.ts'], 'cherry_pick');
      expect(err.operation).toBe('cherry_pick');
      expect(err.message).toContain('cherry_pick');
    });
  });

  describe('BranchNotFoundError', () => {
    it('should create error with branch name', () => {
      const err = new BranchNotFoundError('feature/test');

      expect(err.message).toBe('Branch not found: feature/test');
      expect(err.name).toBe('BranchNotFoundError');
      expect(err.branch).toBe('feature/test');
      expect(err).toBeInstanceOf(GitOperationError);
    });
  });

  describe('WorktreeError', () => {
    it('should create error with message only', () => {
      const err = new WorktreeError('worktree failed');

      expect(err.message).toBe('worktree failed');
      expect(err.name).toBe('WorktreeError');
      expect(err.worktree).toBeUndefined();
      expect(err).toBeInstanceOf(GitOperationError);
    });

    it('should create error with worktree path', () => {
      const err = new WorktreeError('worktree failed', '/path/to/wt');

      expect(err.worktree).toBe('/path/to/wt');
    });
  });

  describe('StreamNotFoundError', () => {
    it('should create error with stream ID', () => {
      const err = new StreamNotFoundError('abc123');

      expect(err.message).toBe('Stream not found: abc123');
      expect(err.name).toBe('StreamNotFoundError');
      expect(err.streamId).toBe('abc123');
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('UnresolvedConflictsError', () => {
    it('should create error with stream ID and conflict count', () => {
      const err = new UnresolvedConflictsError('stream-1', 5);

      expect(err.message).toBe('Stream stream-1 has 5 unresolved conflicts');
      expect(err.name).toBe('UnresolvedConflictsError');
      expect(err.streamId).toBe('stream-1');
      expect(err.conflictCount).toBe(5);
    });

    it('should create error with custom message only', () => {
      const err = new UnresolvedConflictsError('Custom conflict message');

      expect(err.message).toBe('Custom conflict message');
      expect(err.streamId).toBeUndefined();
      expect(err.conflictCount).toBeUndefined();
    });
  });

  describe('CyclicDependencyError', () => {
    it('should create error with message', () => {
      const err = new CyclicDependencyError('A → B → A creates cycle');

      expect(err.message).toBe('A → B → A creates cycle');
      expect(err.name).toBe('CyclicDependencyError');
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('DiamondDependencyError', () => {
    it('should create error with diamond details', () => {
      const err = new DiamondDependencyError(
        'stream-c',
        ['stream-a', 'stream-b'],
        ['abc123', 'def456']
      );

      expect(err.message).toBe(
        'Stream stream-c has diamond dependency on [stream-a, stream-b] - requires manual resolution'
      );
      expect(err.name).toBe('DiamondDependencyError');
      expect(err.streamId).toBe('stream-c');
      expect(err.parents).toEqual(['stream-a', 'stream-b']);
      expect(err.parentHeads).toEqual(['abc123', 'def456']);
    });
  });

  describe('DesyncError', () => {
    it('should create error with desync details', () => {
      const err = new DesyncError('stream-1', 'abc123', 'def456');

      expect(err.message).toBe('Stream stream-1 desync: DB=abc123, Git=def456');
      expect(err.name).toBe('DesyncError');
      expect(err.streamId).toBe('stream-1');
      expect(err.dbState).toBe('abc123');
      expect(err.gitState).toBe('def456');
    });
  });

  describe('LockError', () => {
    it('should create error with lock details', () => {
      const err = new LockError('stream-1', 'agent-42');

      expect(err.message).toBe('Stream stream-1 is locked by agent-42');
      expect(err.name).toBe('LockError');
      expect(err.streamId).toBe('stream-1');
      expect(err.heldBy).toBe('agent-42');
    });
  });

  describe('Error Inheritance', () => {
    it('ConflictError should be catchable as GitOperationError', () => {
      const err = new ConflictError(['file.txt'], 'rebase');

      let caught = false;
      try {
        throw err;
      } catch (e) {
        if (e instanceof GitOperationError) {
          caught = true;
        }
      }
      expect(caught).toBe(true);
    });

    it('BranchNotFoundError should be catchable as GitOperationError', () => {
      const err = new BranchNotFoundError('missing');

      let caught = false;
      try {
        throw err;
      } catch (e) {
        if (e instanceof GitOperationError) {
          caught = true;
        }
      }
      expect(caught).toBe(true);
    });

    it('WorktreeError should be catchable as GitOperationError', () => {
      const err = new WorktreeError('failed');

      let caught = false;
      try {
        throw err;
      } catch (e) {
        if (e instanceof GitOperationError) {
          caught = true;
        }
      }
      expect(caught).toBe(true);
    });
  });
});
