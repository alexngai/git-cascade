/**
 * Checkpoint CRUD tests.
 *
 * Tests for the unified checkpoint system (s-366r).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker } from '../src/tracker.js';
import { createTestRepo } from './setup.js';
import * as checkpoints from '../src/checkpoints.js';
import * as streams from '../src/streams.js';
import * as git from '../src/git/index.js';
import * as fs from 'fs';
import * as path from 'path';

describe('Checkpoint Operations', () => {
  let tracker: MultiAgentRepoTracker;
  let testRepo: ReturnType<typeof createTestRepo>;
  let streamId: string;

  beforeEach(() => {
    testRepo = createTestRepo();
    tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });

    // Create a stream for checkpoint tests
    streamId = tracker.createStream({
      name: 'test-stream',
      agentId: 'agent-1',
    });
  });

  afterEach(() => {
    tracker.close();
    testRepo.cleanup();
  });

  // Helper to create a commit
  function makeCommit(message: string): string {
    const worktreePath = testRepo.path;
    const filePath = path.join(worktreePath, `file-${Date.now()}.txt`);
    fs.writeFileSync(filePath, `content for ${message}`);
    git.stageAll({ cwd: worktreePath });
    return git.commit(message, { cwd: worktreePath });
  }

  describe('createCheckpoint', () => {
    it('should create a checkpoint with required fields', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commitSha = makeCommit('Test commit');

      const checkpoint = checkpoints.createCheckpoint(tracker.db, {
        streamId,
        commitSha,
      });

      expect(checkpoint.id).toMatch(/^cp-/);
      expect(checkpoint.streamId).toBe(streamId);
      expect(checkpoint.commitSha).toBe(commitSha);
      expect(checkpoint.createdAt).toBeGreaterThan(0);
      expect(checkpoint.parentCommit).toBeNull();
      expect(checkpoint.originalCommit).toBeNull();
      expect(checkpoint.changeId).toBeNull();
      expect(checkpoint.message).toBeNull();
      expect(checkpoint.createdBy).toBeNull();
    });

    it('should create a checkpoint with optional fields', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const parentCommit = makeCommit('Parent commit');
      const commitSha = makeCommit('Test commit');

      const checkpoint = checkpoints.createCheckpoint(tracker.db, {
        streamId,
        commitSha,
        parentCommit,
        originalCommit: parentCommit,
        changeId: 'change-123',
        message: 'Test checkpoint message',
        createdBy: 'agent-1',
      });

      expect(checkpoint.parentCommit).toBe(parentCommit);
      expect(checkpoint.originalCommit).toBe(parentCommit);
      expect(checkpoint.changeId).toBe('change-123');
      expect(checkpoint.message).toBe('Test checkpoint message');
      expect(checkpoint.createdBy).toBe('agent-1');
    });

    it('should enforce unique stream/commit combination', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commitSha = makeCommit('Test commit');

      checkpoints.createCheckpoint(tracker.db, {
        streamId,
        commitSha,
      });

      expect(() => {
        checkpoints.createCheckpoint(tracker.db, {
          streamId,
          commitSha,
        });
      }).toThrow();
    });
  });

  describe('getCheckpoint', () => {
    it('should get a checkpoint by ID', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commitSha = makeCommit('Test commit');

      const created = checkpoints.createCheckpoint(tracker.db, {
        streamId,
        commitSha,
      });

      const retrieved = checkpoints.getCheckpoint(tracker.db, created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.streamId).toBe(streamId);
      expect(retrieved!.commitSha).toBe(commitSha);
    });

    it('should return null for non-existent ID', () => {
      const result = checkpoints.getCheckpoint(tracker.db, 'cp-nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getCheckpointByCommit', () => {
    it('should get a checkpoint by stream and commit', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commitSha = makeCommit('Test commit');

      const created = checkpoints.createCheckpoint(tracker.db, {
        streamId,
        commitSha,
      });

      const retrieved = checkpoints.getCheckpointByCommit(
        tracker.db,
        streamId,
        commitSha
      );

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
    });

    it('should return null for non-matching stream', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commitSha = makeCommit('Test commit');

      checkpoints.createCheckpoint(tracker.db, {
        streamId,
        commitSha,
      });

      const result = checkpoints.getCheckpointByCommit(
        tracker.db,
        'other-stream',
        commitSha
      );
      expect(result).toBeNull();
    });
  });

  describe('getCheckpointsForStream', () => {
    it('should get all checkpoints for a stream ordered by creation time', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');
      const commit3 = makeCommit('Commit 3');

      checkpoints.createCheckpoint(tracker.db, { streamId, commitSha: commit1 });
      checkpoints.createCheckpoint(tracker.db, { streamId, commitSha: commit2 });
      checkpoints.createCheckpoint(tracker.db, { streamId, commitSha: commit3 });

      const results = checkpoints.getCheckpointsForStream(tracker.db, streamId);

      expect(results).toHaveLength(3);
      expect(results[0].commitSha).toBe(commit1);
      expect(results[1].commitSha).toBe(commit2);
      expect(results[2].commitSha).toBe(commit3);
    });

    it('should return empty array for stream with no checkpoints', () => {
      const results = checkpoints.getCheckpointsForStream(
        tracker.db,
        'empty-stream'
      );
      expect(results).toHaveLength(0);
    });
  });

  describe('getCheckpointsByChangeId', () => {
    it('should get all checkpoints with same change ID', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');

      const changeId = 'stable-change-id';

      checkpoints.createCheckpoint(tracker.db, {
        streamId,
        commitSha: commit1,
        changeId,
      });
      checkpoints.createCheckpoint(tracker.db, {
        streamId,
        commitSha: commit2,
        changeId,
      });

      const results = checkpoints.getCheckpointsByChangeId(tracker.db, changeId);

      expect(results).toHaveLength(2);
      expect(results.every((cp) => cp.changeId === changeId)).toBe(true);
    });
  });

  describe('listCheckpoints', () => {
    it('should list all checkpoints', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');

      checkpoints.createCheckpoint(tracker.db, { streamId, commitSha: commit1 });
      checkpoints.createCheckpoint(tracker.db, { streamId, commitSha: commit2 });

      const results = checkpoints.listCheckpoints(tracker.db);

      expect(results).toHaveLength(2);
    });

    it('should filter by streamId', () => {
      const stream2 = tracker.createStream({
        name: 'stream-2',
        agentId: 'agent-1',
      });

      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      git.checkout(`stream/${stream2}`, { cwd: testRepo.path });
      const commit2 = makeCommit('Commit 2');

      checkpoints.createCheckpoint(tracker.db, {
        streamId,
        commitSha: commit1,
      });
      checkpoints.createCheckpoint(tracker.db, {
        streamId: stream2,
        commitSha: commit2,
      });

      const results = checkpoints.listCheckpoints(tracker.db, {
        streamId,
      });

      expect(results).toHaveLength(1);
      expect(results[0].streamId).toBe(streamId);
    });

    it('should filter by changeId', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');

      checkpoints.createCheckpoint(tracker.db, {
        streamId,
        commitSha: commit1,
        changeId: 'change-A',
      });
      checkpoints.createCheckpoint(tracker.db, {
        streamId,
        commitSha: commit2,
        changeId: 'change-B',
      });

      const results = checkpoints.listCheckpoints(tracker.db, {
        changeId: 'change-A',
      });

      expect(results).toHaveLength(1);
      expect(results[0].changeId).toBe('change-A');
    });
  });

  describe('deleteCheckpoint', () => {
    it('should delete a checkpoint by ID', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commitSha = makeCommit('Test commit');

      const checkpoint = checkpoints.createCheckpoint(tracker.db, {
        streamId,
        commitSha,
      });

      const deleted = checkpoints.deleteCheckpoint(tracker.db, checkpoint.id);
      expect(deleted).toBe(true);

      const retrieved = checkpoints.getCheckpoint(tracker.db, checkpoint.id);
      expect(retrieved).toBeNull();
    });

    it('should return false for non-existent ID', () => {
      const deleted = checkpoints.deleteCheckpoint(tracker.db, 'cp-nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('deleteCheckpointsForStream', () => {
    it('should delete all checkpoints for a stream', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit1 = makeCommit('Commit 1');
      const commit2 = makeCommit('Commit 2');

      checkpoints.createCheckpoint(tracker.db, { streamId, commitSha: commit1 });
      checkpoints.createCheckpoint(tracker.db, { streamId, commitSha: commit2 });

      const deleted = checkpoints.deleteCheckpointsForStream(
        tracker.db,
        streamId
      );
      expect(deleted).toBe(2);

      const results = checkpoints.getCheckpointsForStream(tracker.db, streamId);
      expect(results).toHaveLength(0);
    });

    it('should return 0 for stream with no checkpoints', () => {
      const deleted = checkpoints.deleteCheckpointsForStream(
        tracker.db,
        'empty-stream'
      );
      expect(deleted).toBe(0);
    });
  });

  describe('forkFromCheckpoint', () => {
    it('should create a new stream from a checkpoint', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit = makeCommit('Test commit');

      const checkpoint = checkpoints.createCheckpoint(tracker.db, {
        streamId,
        commitSha: commit,
      });

      const newStreamId = streams.forkFromCheckpoint(
        tracker.db,
        testRepo.path,
        {
          checkpointId: checkpoint.id,
          name: 'forked-stream',
          agentId: 'agent-2',
        }
      );

      const newStream = tracker.getStream(newStreamId);
      expect(newStream).not.toBeNull();
      expect(newStream!.name).toBe('forked-stream');
      expect(newStream!.parentStream).toBe(streamId);
      expect(newStream!.baseCommit).toBe(commit);
    });

    it('should use default name if not provided', () => {
      git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
      const commit = makeCommit('Test commit');

      const checkpoint = checkpoints.createCheckpoint(tracker.db, {
        streamId,
        commitSha: commit,
      });

      const newStreamId = streams.forkFromCheckpoint(
        tracker.db,
        testRepo.path,
        {
          checkpointId: checkpoint.id,
          agentId: 'agent-2',
        }
      );

      const newStream = tracker.getStream(newStreamId);
      expect(newStream!.name).toBe(`fork-of-${checkpoint.id}`);
    });

    it('should throw if checkpoint not found', () => {
      expect(() => {
        streams.forkFromCheckpoint(tracker.db, testRepo.path, {
          checkpointId: 'cp-nonexistent',
          agentId: 'agent-1',
        });
      }).toThrow('Checkpoint not found');
    });
  });
});
