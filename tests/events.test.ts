/**
 * Tests for the optional event emission hook.
 *
 * Verifies that the tracker fires `cascade/*` events with the right payloads
 * after each operation, and that omitting the emitter is fully backwards
 * compatible (no errors, no overhead beyond a null check).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  MultiAgentRepoTracker,
  CASCADE_METHODS,
  CASCADE_METHOD_SUFFIXES,
  DEFAULT_CASCADE_PREFIX,
  buildCascadeMethods,
  matchCascadeSuffix,
  type CascadeEmitter,
  type StreamOpenedParams,
  type StreamCommittedParams,
  type StreamMergedParams,
  type StreamConflictedParams,
  type StreamAbandonedParams,
} from '../src/index.js';
import { createTestRepo, type TestRepo } from './setup.js';

interface CapturedEvent {
  method: string;
  params: unknown;
}

function createCapturingEmitter(): {
  emit: CascadeEmitter;
  events: CapturedEvent[];
} {
  const events: CapturedEvent[] = [];
  const emit: CascadeEmitter = (method, params) => {
    events.push({ method, params });
  };
  return { emit, events };
}

function setupWorktree(repoPath: string, agentId: string, branch: string): string {
  const wt = path.join(repoPath, '..', `worktree-${agentId}-${Date.now()}`);
  // git worktree add <path> <branch> (branch must already exist via stream creation)
  execSync(`git worktree add "${wt}" ${branch}`, { cwd: repoPath, stdio: 'pipe' });
  return wt;
}

function writeFile(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content);
}

describe('cascade event emission', () => {
  let testRepo: TestRepo;

  beforeEach(() => {
    testRepo = createTestRepo();
  });

  afterEach(() => {
    testRepo.cleanup();
  });

  describe('emitter omitted (regression: standalone mode)', () => {
    it('runs full lifecycle without errors when no emit callback is provided', () => {
      const tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });
      try {
        const streamId = tracker.createStream({
          name: 'no-emit',
          agentId: 'agent-1',
        });
        expect(streamId).toBeTruthy();

        tracker.abandonStream(streamId, { reason: 'done' });
        const stream = tracker.getStream(streamId);
        expect(stream?.status).toBe('abandoned');
      } finally {
        tracker.close();
      }
    });
  });

  describe('stream.opened', () => {
    it('fires with full stream metadata after createStream', () => {
      const { emit, events } = createCapturingEmitter();
      const tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path, emit });
      try {
        const streamId = tracker.createStream({
          name: 'feature-x',
          agentId: 'agent-1',
          metadata: { task_ref: { resource_id: 'r1', node_id: 'n1' } },
        });

        const opened = events.find((e) => e.method === CASCADE_METHODS.STREAM_OPENED);
        expect(opened).toBeDefined();
        const params = opened!.params as StreamOpenedParams;
        expect(params.stream_id).toBe(streamId);
        expect(params.name).toBe('feature-x');
        expect(params.agent_id).toBe('agent-1');
        expect(params.base_commit).toBeTruthy();
        expect(params.parent_stream).toBeUndefined();
        expect(params.branch_name).toBe(`stream/${streamId}`);
        expect(params.is_local_mode).toBe(false);
        expect(params.metadata).toEqual({
          task_ref: { resource_id: 'r1', node_id: 'n1' },
        });
      } finally {
        tracker.close();
      }
    });

    it('fires for forkStream with parent_stream populated', () => {
      const { emit, events } = createCapturingEmitter();
      const tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path, emit });
      try {
        const parentId = tracker.createStream({ name: 'parent', agentId: 'agent-1' });
        events.length = 0;
        const childId = tracker.forkStream({
          parentStreamId: parentId,
          name: 'child',
          agentId: 'agent-2',
        });

        const opened = events.find((e) => e.method === CASCADE_METHODS.STREAM_OPENED);
        expect(opened).toBeDefined();
        const params = opened!.params as StreamOpenedParams;
        expect(params.stream_id).toBe(childId);
        expect(params.parent_stream).toBe(parentId);
        expect(params.agent_id).toBe('agent-2');
      } finally {
        tracker.close();
      }
    });
  });

  describe('stream.committed', () => {
    it('fires with commit_hash, change_id, files_touched, and metadata', () => {
      const { emit, events } = createCapturingEmitter();
      const tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path, emit });
      try {
        const streamId = tracker.createStream({ name: 'feat', agentId: 'agent-1' });
        const wt = setupWorktree(testRepo.path, 'agent-1', `stream/${streamId}`);

        writeFile(wt, 'src.txt', 'hello');
        writeFile(wt, 'docs.txt', 'world');

        events.length = 0;
        const result = tracker.commitChanges({
          streamId,
          agentId: 'agent-1',
          worktree: wt,
          message: 'feat: add src and docs\n\ndetails here',
          metadata: { trigger: 'manual', task_ref: { resource_id: 'r1', node_id: 'n1' } },
        });

        const committed = events.find((e) => e.method === CASCADE_METHODS.STREAM_COMMITTED);
        expect(committed).toBeDefined();
        const params = committed!.params as StreamCommittedParams;
        expect(params.stream_id).toBe(streamId);
        expect(params.commit_hash).toBe(result.commit);
        expect(params.change_id).toBe(result.changeId);
        expect(params.agent_id).toBe('agent-1');
        expect(params.message_summary).toBe('feat: add src and docs');
        expect(params.files_touched.sort()).toEqual(['docs.txt', 'src.txt']);
        expect(params.parent_commit).toBeTruthy();
        expect(params.metadata).toEqual({
          trigger: 'manual',
          task_ref: { resource_id: 'r1', node_id: 'n1' },
        });
      } finally {
        tracker.close();
      }
    });
  });

  describe('stream.abandoned', () => {
    it('fires with reason and cascade flag', () => {
      const { emit, events } = createCapturingEmitter();
      const tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path, emit });
      try {
        const streamId = tracker.createStream({ name: 'temp', agentId: 'agent-1' });
        events.length = 0;
        tracker.abandonStream(streamId, { reason: 'superseded', cascade: false });

        const abandoned = events.find((e) => e.method === CASCADE_METHODS.STREAM_ABANDONED);
        expect(abandoned).toBeDefined();
        const params = abandoned!.params as StreamAbandonedParams;
        expect(params.stream_id).toBe(streamId);
        expect(params.reason).toBe('superseded');
        expect(params.cascade).toBe(false);
      } finally {
        tracker.close();
      }
    });
  });

  describe('stream.merged', () => {
    it('fires after a successful mergeStream with strategy and source_commit', () => {
      const { emit, events } = createCapturingEmitter();
      const tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path, emit });
      try {
        const targetId = tracker.createStream({ name: 'main-feat', agentId: 'agent-1' });
        const sourceId = tracker.forkStream({
          parentStreamId: targetId,
          name: 'sub-feat',
          agentId: 'agent-2',
        });
        const wt = setupWorktree(testRepo.path, 'agent-2', `stream/${sourceId}`);
        writeFile(wt, 'a.txt', 'a');
        tracker.commitChanges({
          streamId: sourceId,
          agentId: 'agent-2',
          worktree: wt,
          message: 'feat: a',
        });

        events.length = 0;
        const result = tracker.mergeStream({
          sourceStream: sourceId,
          targetStream: targetId,
          agentId: 'agent-2',
          worktree: wt,
        });

        if (result.success) {
          const merged = events.find((e) => e.method === CASCADE_METHODS.STREAM_MERGED);
          expect(merged).toBeDefined();
          const params = merged!.params as StreamMergedParams;
          expect(params.source_stream_id).toBe(sourceId);
          expect(params.target_stream_id).toBe(targetId);
          expect(params.merge_commit).toBe(result.newHead);
          expect(params.agent_id).toBe('agent-2');
          expect(params.strategy).toBe('merge-commit');
          expect(params.source_commit).toBeTruthy();
        }
      } finally {
        tracker.close();
      }
    });
  });

  describe('stream.conflicted', () => {
    it('fires from createConflict with conflicted_files and source=manual', () => {
      const { emit, events } = createCapturingEmitter();
      const tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path, emit });
      try {
        const streamId = tracker.createStream({ name: 'feat', agentId: 'agent-1' });
        events.length = 0;
        const conflictId = tracker.createConflict({
          streamId,
          conflictingCommit: 'aaaaaaa',
          targetCommit: 'bbbbbbb',
          conflictedFiles: ['a.txt', 'b.txt'],
        });

        const conflicted = events.find((e) => e.method === CASCADE_METHODS.STREAM_CONFLICTED);
        expect(conflicted).toBeDefined();
        const params = conflicted!.params as StreamConflictedParams;
        expect(params.stream_id).toBe(streamId);
        expect(params.conflict_id).toBe(conflictId);
        expect(params.conflicted_files).toEqual(['a.txt', 'b.txt']);
        expect(params.conflicting_commit).toBe('aaaaaaa');
        expect(params.target_commit).toBe('bbbbbbb');
        expect(params.source).toBe('manual');
      } finally {
        tracker.close();
      }
    });
  });

  describe('emit safety', () => {
    it('does not propagate exceptions thrown by the emit callback', () => {
      const tracker = new MultiAgentRepoTracker({
        repoPath: testRepo.path,
        emit: () => {
          throw new Error('observer is on fire');
        },
      });
      try {
        // Should not throw despite the emitter throwing.
        const streamId = tracker.createStream({ name: 'feat', agentId: 'agent-1' });
        expect(streamId).toBeTruthy();
      } finally {
        tracker.close();
      }
    });
  });

  describe('event prefix', () => {
    it('uses the default x-cascade prefix when none is configured', () => {
      const { emit, events } = createCapturingEmitter();
      const tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path, emit });
      try {
        tracker.createStream({ name: 'feat', agentId: 'agent-1' });
        expect(events[0].method).toBe(CASCADE_METHODS.STREAM_OPENED);
        expect(events[0].method).toBe(`${DEFAULT_CASCADE_PREFIX}/stream.opened`);
      } finally {
        tracker.close();
      }
    });

    it('honors a custom eventPrefix for all emitted methods', () => {
      const { emit, events } = createCapturingEmitter();
      const tracker = new MultiAgentRepoTracker({
        repoPath: testRepo.path,
        emit,
        eventPrefix: 'x-acme-cascade',
      });
      try {
        const streamId = tracker.createStream({ name: 'feat', agentId: 'agent-1' });
        tracker.abandonStream(streamId, { reason: 'test' });

        const custom = buildCascadeMethods('x-acme-cascade');
        expect(events[0].method).toBe(custom.STREAM_OPENED);
        expect(events[0].method).toBe('x-acme-cascade/stream.opened');
        expect(events[1].method).toBe(custom.STREAM_ABANDONED);
        expect(events[1].method).toBe('x-acme-cascade/stream.abandoned');
      } finally {
        tracker.close();
      }
    });

    it('matchCascadeSuffix narrows events regardless of prefix', () => {
      const { emit, events } = createCapturingEmitter();
      const tracker = new MultiAgentRepoTracker({
        repoPath: testRepo.path,
        emit,
        eventPrefix: 'x-weird_prefix_v2',
      });
      try {
        tracker.createStream({ name: 'feat', agentId: 'agent-1' });
        const suffix = matchCascadeSuffix(events[0].method);
        expect(suffix).toBe(CASCADE_METHOD_SUFFIXES.STREAM_OPENED);
        expect(suffix).toBe('stream.opened');
      } finally {
        tracker.close();
      }
    });
  });
});
