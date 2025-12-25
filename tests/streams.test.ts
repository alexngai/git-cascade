/**
 * Stream CRUD tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker } from '../src/index.js';
import { createTestRepo, commitFile, type TestRepo } from './setup.js';

describe('Stream Operations', () => {
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

  describe('createStream', () => {
    it('should create a stream from main', () => {
      const streamId = tracker.createStream({
        name: 'feature-test',
        agentId: 'agent-1',
      });

      expect(streamId).toMatch(/^[a-f0-9]{8}$/);

      const stream = tracker.getStream(streamId);
      expect(stream).not.toBeNull();
      expect(stream!.name).toBe('feature-test');
      expect(stream!.agentId).toBe('agent-1');
      expect(stream!.status).toBe('active');
      expect(stream!.parentStream).toBeNull();
    });

    it('should create a stream from a specific commit', () => {
      // Make a commit
      const commit = commitFile(
        testRepo.path,
        'test.txt',
        'content',
        'Add test file'
      );

      const streamId = tracker.createStream({
        name: 'from-commit',
        agentId: 'agent-1',
        base: commit,
      });

      const stream = tracker.getStream(streamId);
      expect(stream!.baseCommit).toBe(commit);
    });

    it('should create git branch for stream', () => {
      const streamId = tracker.createStream({
        name: 'with-branch',
        agentId: 'agent-1',
      });

      // Verify branch exists
      const head = tracker.getStreamHead(streamId);
      expect(head).toMatch(/^[a-f0-9]{40}$/);
    });

    it('should enable stacked review when requested', () => {
      const streamId = tracker.createStream({
        name: 'stacked',
        agentId: 'agent-1',
        enableStackedReview: true,
      });

      const stream = tracker.getStream(streamId);
      expect(stream!.enableStackedReview).toBe(true);
    });
  });

  describe('listStreams', () => {
    it('should list all streams', () => {
      tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      tracker.createStream({ name: 'stream-2', agentId: 'agent-2' });

      const streams = tracker.listStreams();
      expect(streams).toHaveLength(2);
    });

    it('should filter by agent', () => {
      tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      tracker.createStream({ name: 'stream-2', agentId: 'agent-2' });
      tracker.createStream({ name: 'stream-3', agentId: 'agent-1' });

      const streams = tracker.listStreams({ agentId: 'agent-1' });
      expect(streams).toHaveLength(2);
      expect(streams.every((s) => s.agentId === 'agent-1')).toBe(true);
    });

    it('should filter by status', () => {
      const id1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });
      tracker.abandonStream(id1);

      const active = tracker.listStreams({ status: 'active' });
      expect(active).toHaveLength(1);

      const abandoned = tracker.listStreams({ status: 'abandoned' });
      expect(abandoned).toHaveLength(1);
    });
  });

  describe('updateStream', () => {
    it('should update stream name', () => {
      const streamId = tracker.createStream({
        name: 'original',
        agentId: 'agent-1',
      });

      tracker.updateStream(streamId, { name: 'renamed' });

      const stream = tracker.getStream(streamId);
      expect(stream!.name).toBe('renamed');
    });

    it('should update stream status', () => {
      const streamId = tracker.createStream({
        name: 'test',
        agentId: 'agent-1',
      });

      tracker.updateStream(streamId, { status: 'paused' });

      const stream = tracker.getStream(streamId);
      expect(stream!.status).toBe('paused');
    });

    it('should merge metadata', () => {
      const streamId = tracker.createStream({
        name: 'test',
        agentId: 'agent-1',
        metadata: { original: true },
      });

      tracker.updateStream(streamId, { metadata: { added: 'value' } });

      const stream = tracker.getStream(streamId);
      expect(stream!.metadata).toEqual({ original: true, added: 'value' });
    });
  });

  describe('abandonStream', () => {
    it('should mark stream as abandoned', () => {
      const streamId = tracker.createStream({
        name: 'to-abandon',
        agentId: 'agent-1',
      });

      tracker.abandonStream(streamId, 'No longer needed');

      const stream = tracker.getStream(streamId);
      expect(stream!.status).toBe('abandoned');
      expect(stream!.metadata.abandonReason).toBe('No longer needed');
    });
  });

  describe('forkStream', () => {
    it('should create child stream from parent', () => {
      const parentId = tracker.createStream({
        name: 'parent',
        agentId: 'agent-1',
      });

      // Add a commit to parent
      commitFile(testRepo.path, 'parent.txt', 'content', 'Parent commit');

      const childId = tracker.forkStream({
        parentStreamId: parentId,
        name: 'child',
        agentId: 'agent-2',
      });

      const child = tracker.getStream(childId);
      expect(child!.parentStream).toBe(parentId);
    });
  });
});
