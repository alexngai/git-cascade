/**
 * Comprehensive tracker tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MultiAgentRepoTracker } from '../src/index.js';
import { createTestRepo, commitFile, type TestRepo } from './setup.js';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

describe('MultiAgentRepoTracker', () => {
  let testRepo: TestRepo;
  let tracker: MultiAgentRepoTracker;

  beforeEach(() => {
    testRepo = createTestRepo();
    tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });
  });

  afterEach(() => {
    tracker.close();
    testRepo.cleanup();
  });

  describe('initialization', () => {
    it('should initialize with a repo path', () => {
      expect(tracker.repoPath).toBe(testRepo.path);
    });

    it('should create database with WAL mode', () => {
      const mode = tracker.db.pragma('journal_mode', { simple: true });
      expect(mode).toBe('wal');
    });

    it('should have all required tables', () => {
      const tables = tracker.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row: { name: string }) => row.name);

      expect(tables).toContain('streams');
      expect(tables).toContain('operations');
      expect(tables).toContain('stack_entries');
      expect(tables).toContain('agent_worktrees');
      expect(tables).toContain('stream_locks');
      expect(tables).toContain('stream_guards');
      expect(tables).toContain('changes');
      expect(tables).toContain('dependencies');
      expect(tables).toContain('conflicts');
    });

    it('should use custom database path when provided', () => {
      tracker.close();
      const customDbPath = path.join(testRepo.path, 'custom.db');
      const customTracker = new MultiAgentRepoTracker({
        repoPath: testRepo.path,
        dbPath: customDbPath,
      });

      expect(fs.existsSync(customDbPath)).toBe(true);
      customTracker.close();
    });
  });

  describe('stream lifecycle', () => {
    it('should create and retrieve a stream', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      const stream = tracker.getStream(streamId);
      expect(stream).not.toBeNull();
      expect(stream!.name).toBe('test-stream');
      expect(stream!.agentId).toBe('agent-1');
      expect(stream!.status).toBe('active');
    });

    it('should list all streams', () => {
      tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      tracker.createStream({ name: 'stream-2', agentId: 'agent-2' });

      const streams = tracker.listStreams();
      expect(streams).toHaveLength(2);
    });

    it('should fork a stream', () => {
      const parentId = tracker.createStream({
        name: 'parent',
        agentId: 'agent-1',
      });

      const childId = tracker.forkStream({
        parentStreamId: parentId,
        name: 'child',
        agentId: 'agent-2',
      });

      const child = tracker.getStream(childId);
      expect(child!.parentStream).toBe(parentId);
    });

    it('should abandon a stream', () => {
      const streamId = tracker.createStream({
        name: 'to-abandon',
        agentId: 'agent-1',
      });

      tracker.abandonStream(streamId, { reason: 'No longer needed' });

      const stream = tracker.getStream(streamId);
      expect(stream!.status).toBe('abandoned');
    });

    it('should pause and resume a stream', () => {
      const streamId = tracker.createStream({
        name: 'to-pause',
        agentId: 'agent-1',
      });

      tracker.pauseStream(streamId, 'Break time');
      expect(tracker.getStream(streamId)!.status).toBe('paused');

      tracker.resumeStream(streamId);
      expect(tracker.getStream(streamId)!.status).toBe('active');
    });
  });

  describe('trackExistingBranch', () => {
    it('should track an existing branch', () => {
      // Create a branch
      execSync('git checkout -b feature-branch', { cwd: testRepo.path, stdio: 'pipe' });
      commitFile(testRepo.path, 'feature.txt', 'content', 'Feature commit');
      execSync('git checkout main', { cwd: testRepo.path, stdio: 'pipe' });

      const streamId = tracker.trackExistingBranch({
        branch: 'feature-branch',
        agentId: 'agent-1',
      });

      const stream = tracker.getStream(streamId);
      expect(stream!.isLocalMode).toBe(true);
      expect(stream!.existingBranch).toBe('feature-branch');
    });
  });

  describe('worktree management', () => {
    it('should create and deallocate worktrees', () => {
      const worktreePath = path.join(testRepo.path, '.worktrees', 'agent-1');

      const worktree = tracker.createWorktree({
        agentId: 'agent-1',
        path: worktreePath,
      });

      expect(worktree.agentId).toBe('agent-1');
      expect(worktree.path).toBe(worktreePath);
      expect(fs.existsSync(worktreePath)).toBe(true);

      tracker.deallocateWorktree('agent-1');
      // Worktree should be removed
    });

    it('should get worktree by agent ID', () => {
      const worktreePath = path.join(testRepo.path, '.worktrees', 'agent-get');

      tracker.createWorktree({
        agentId: 'agent-get',
        path: worktreePath,
      });

      const worktree = tracker.getWorktree('agent-get');
      expect(worktree).not.toBeNull();
      expect(worktree!.agentId).toBe('agent-get');

      tracker.deallocateWorktree('agent-get');
    });

    it('should list all worktrees', () => {
      const wt1 = path.join(testRepo.path, '.worktrees', 'agent-list-1');
      const wt2 = path.join(testRepo.path, '.worktrees', 'agent-list-2');

      tracker.createWorktree({ agentId: 'agent-list-1', path: wt1 });
      tracker.createWorktree({ agentId: 'agent-list-2', path: wt2 });

      const worktrees = tracker.listWorktrees();
      expect(worktrees.length).toBeGreaterThanOrEqual(2);

      tracker.deallocateWorktree('agent-list-1');
      tracker.deallocateWorktree('agent-list-2');
    });
  });

  describe('operation recording', () => {
    it('should record operations', () => {
      const streamId = tracker.createStream({
        name: 'ops-test',
        agentId: 'agent-1',
      });

      const opId = tracker.recordOperation({
        streamId,
        agentId: 'agent-1',
        opType: 'commit',
        beforeState: 'abc123',
        afterState: 'def456',
      });

      expect(opId).toMatch(/^op-[a-f0-9]{8}$/);

      const op = tracker.getOperation(opId);
      expect(op).not.toBeNull();
      expect(op!.streamId).toBe(streamId);
      expect(op!.opType).toBe('commit');
    });

    it('should get operations for a stream', () => {
      const streamId = tracker.createStream({
        name: 'ops-stream',
        agentId: 'agent-1',
      });

      tracker.recordOperation({
        streamId,
        agentId: 'agent-1',
        opType: 'commit',
        beforeState: 'a',
        afterState: 'b',
      });

      tracker.recordOperation({
        streamId,
        agentId: 'agent-1',
        opType: 'amend',
        beforeState: 'b',
        afterState: 'c',
      });

      const ops = tracker.getOperations({ streamId });
      expect(ops).toHaveLength(2);
    });
  });

  describe('change tracking', () => {
    it('should create and retrieve changes', () => {
      const streamId = tracker.createStream({
        name: 'changes-test',
        agentId: 'agent-1',
      });

      const changeId = tracker.createChange({
        streamId,
        commit: 'abc123',
        description: 'Test change',
      });

      expect(changeId).toMatch(/^c-[a-f0-9]{8}$/);

      const change = tracker.getChange(changeId);
      expect(change).not.toBeNull();
      expect(change!.streamId).toBe(streamId);
      expect(change!.description).toBe('Test change');
    });

    it('should get changes for a stream', () => {
      const streamId = tracker.createStream({
        name: 'changes-stream',
        agentId: 'agent-1',
      });

      tracker.createChange({
        streamId,
        commit: 'abc123',
        description: 'Change 1',
      });

      tracker.createChange({
        streamId,
        commit: 'def456',
        description: 'Change 2',
      });

      const changes = tracker.getChangesForStream(streamId);
      expect(changes).toHaveLength(2);
    });
  });

  describe('stream hierarchy', () => {
    it('should get stream hierarchy', () => {
      const parentId = tracker.createStream({
        name: 'hierarchy-parent',
        agentId: 'agent-1',
      });

      const child1 = tracker.forkStream({
        parentStreamId: parentId,
        name: 'child-1',
        agentId: 'agent-1',
      });

      const child2 = tracker.forkStream({
        parentStreamId: parentId,
        name: 'child-2',
        agentId: 'agent-1',
      });

      const hierarchy = tracker.getStreamHierarchy(parentId);
      expect(Array.isArray(hierarchy)).toBe(false);

      const node = hierarchy as { stream: { id: string }; children: unknown[] };
      expect(node.stream.id).toBe(parentId);
      expect(node.children).toHaveLength(2);
    });

    it('should get all root streams without parameter', () => {
      tracker.createStream({ name: 'root-1', agentId: 'agent-1' });
      tracker.createStream({ name: 'root-2', agentId: 'agent-1' });

      const hierarchy = tracker.getStreamHierarchy();
      expect(Array.isArray(hierarchy)).toBe(true);
      expect((hierarchy as unknown[]).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('conflict management', () => {
    it('should create and retrieve conflicts', () => {
      const streamId = tracker.createStream({
        name: 'conflict-test',
        agentId: 'agent-1',
      });

      const conflictId = tracker.createConflict({
        streamId,
        conflictingCommit: 'abc123',
        targetCommit: 'def456',
        conflictedFiles: ['file1.txt', 'file2.txt'],
      });

      const conflict = tracker.getConflict(conflictId);
      expect(conflict).not.toBeNull();
      expect(conflict!.streamId).toBe(streamId);
      expect(conflict!.conflictedFiles).toHaveLength(2);
    });

    it('should get conflict for a stream', () => {
      const streamId = tracker.createStream({
        name: 'conflict-stream',
        agentId: 'agent-1',
      });

      tracker.createConflict({
        streamId,
        conflictingCommit: 'abc123',
        targetCommit: 'def456',
        conflictedFiles: ['file.txt'],
      });

      const conflict = tracker.getConflictForStream(streamId);
      expect(conflict).not.toBeNull();
    });
  });

  describe('dependencies', () => {
    it('should track stream dependencies', () => {
      const parentId = tracker.createStream({
        name: 'dep-parent',
        agentId: 'agent-1',
      });

      const childId = tracker.forkStream({
        parentStreamId: parentId,
        name: 'dep-child',
        agentId: 'agent-1',
      });

      const deps = tracker.getDependencies(childId);
      expect(deps).toContain(parentId);
    });

    it('should get dependents of a stream', () => {
      const parentId = tracker.createStream({
        name: 'dependents-parent',
        agentId: 'agent-1',
      });

      const childId = tracker.forkStream({
        parentStreamId: parentId,
        name: 'dependents-child',
        agentId: 'agent-1',
      });

      const dependents = tracker.getDependents(parentId);
      expect(dependents).toContain(childId);
    });
  });

  describe('deprecated API warning', () => {
    it('should warn when using getStreamGraph', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const streamId = tracker.createStream({
        name: 'deprecated-test',
        agentId: 'agent-1',
      });

      tracker.getStreamGraph(streamId);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('getStreamGraph is deprecated')
      );

      consoleWarnSpy.mockRestore();
    });
  });

  describe('error handling', () => {
    it('should throw StreamNotFoundError for invalid stream ID', () => {
      expect(() => tracker.abandonStream('invalid-id')).toThrow(/Stream not found/);
    });

    it('should throw when pausing non-active stream', () => {
      const streamId = tracker.createStream({
        name: 'pause-error',
        agentId: 'agent-1',
      });

      tracker.abandonStream(streamId);

      expect(() => tracker.pauseStream(streamId)).toThrow(/Cannot pause stream/);
    });

    it('should throw when resuming non-paused stream', () => {
      const streamId = tracker.createStream({
        name: 'resume-error',
        agentId: 'agent-1',
      });

      expect(() => tracker.resumeStream(streamId)).toThrow(/Cannot resume stream/);
    });

    it('should throw when tracking non-existent branch', () => {
      expect(() =>
        tracker.trackExistingBranch({
          branch: 'does-not-exist',
          agentId: 'agent-1',
        })
      ).toThrow(/Branch not found/);
    });
  });
});
