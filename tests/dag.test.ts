/**
 * Stream DAG (Directed Acyclic Graph) operation tests.
 *
 * Tests for stream lineage tracking and merge event recording.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker, streams } from '../src/index.js';
import { createTestRepo, commitFile, type TestRepo } from './setup.js';

describe('Stream DAG Operations', () => {
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

  describe('branchPointCommit', () => {
    it('should set branchPointCommit when creating stream with parentStream', () => {
      // Create parent stream
      const parentId = tracker.createStream({
        name: 'parent',
        agentId: 'agent-1',
      });

      // Create child stream
      const parentHead = tracker.getStreamHead(parentId);
      const childId = tracker.createStream({
        name: 'child',
        agentId: 'agent-1',
        parentStream: parentId,
        base: parentHead,
      });

      const child = tracker.getStream(childId);
      expect(child).not.toBeNull();
      expect(child!.parentStream).toBe(parentId);
      expect(child!.branchPointCommit).toBe(parentHead);
    });

    it('should allow explicit branchPointCommit override', () => {
      // Create parent stream and make a commit
      const parentId = tracker.createStream({
        name: 'parent',
        agentId: 'agent-1',
      });

      const parentHead = tracker.getStreamHead(parentId);

      // Make another commit on main
      const newCommit = commitFile(
        testRepo.path,
        'test.txt',
        'content',
        'Add test file'
      );

      // Create child with explicit branchPointCommit
      const childId = tracker.createStream({
        name: 'child',
        agentId: 'agent-1',
        parentStream: parentId,
        base: newCommit,
        branchPointCommit: parentHead, // Explicitly set to parent's head
      });

      const child = tracker.getStream(childId);
      expect(child!.branchPointCommit).toBe(parentHead);
      expect(child!.baseCommit).toBe(newCommit);
    });

    it('should not set branchPointCommit for root streams', () => {
      const streamId = tracker.createStream({
        name: 'root',
        agentId: 'agent-1',
      });

      const stream = tracker.getStream(streamId);
      expect(stream!.parentStream).toBeNull();
      expect(stream!.branchPointCommit).toBeNull();
    });
  });

  describe('getStreamLineage', () => {
    it('should return single stream for root stream', () => {
      const rootId = tracker.createStream({
        name: 'root',
        agentId: 'agent-1',
      });

      const lineage = streams.getStreamLineage(tracker.db, rootId);
      expect(lineage).toHaveLength(1);
      expect(lineage[0].id).toBe(rootId);
    });

    it('should return full lineage from root to leaf', () => {
      // Create a chain: root -> child1 -> child2
      const rootId = tracker.createStream({
        name: 'root',
        agentId: 'agent-1',
      });

      const child1Id = tracker.createStream({
        name: 'child1',
        agentId: 'agent-1',
        parentStream: rootId,
        base: tracker.getStreamHead(rootId),
      });

      const child2Id = tracker.createStream({
        name: 'child2',
        agentId: 'agent-1',
        parentStream: child1Id,
        base: tracker.getStreamHead(child1Id),
      });

      const lineage = streams.getStreamLineage(tracker.db, child2Id);
      expect(lineage).toHaveLength(3);
      expect(lineage[0].id).toBe(rootId);
      expect(lineage[1].id).toBe(child1Id);
      expect(lineage[2].id).toBe(child2Id);
    });

    it('should return lineage in root-first order', () => {
      // Create chain
      const rootId = tracker.createStream({
        name: 'root',
        agentId: 'agent-1',
      });

      const childId = tracker.createStream({
        name: 'child',
        agentId: 'agent-1',
        parentStream: rootId,
        base: tracker.getStreamHead(rootId),
      });

      const lineage = streams.getStreamLineage(tracker.db, childId);

      // First element should be root (no parent)
      expect(lineage[0].parentStream).toBeNull();
      // Last element should be the requested stream
      expect(lineage[lineage.length - 1].id).toBe(childId);
    });

    it('should handle deep lineage (5+ levels)', () => {
      let currentId = tracker.createStream({
        name: 'level-0',
        agentId: 'agent-1',
      });

      for (let i = 1; i <= 5; i++) {
        currentId = tracker.createStream({
          name: `level-${i}`,
          agentId: 'agent-1',
          parentStream: currentId,
          base: tracker.getStreamHead(currentId),
        });
      }

      const lineage = streams.getStreamLineage(tracker.db, currentId);
      expect(lineage).toHaveLength(6);
      expect(lineage[0].name).toBe('level-0');
      expect(lineage[5].name).toBe('level-5');
    });
  });

  describe('getChildStreams', () => {
    it('should return empty array for stream with no children', () => {
      const streamId = tracker.createStream({
        name: 'lonely',
        agentId: 'agent-1',
      });

      const children = streams.getChildStreams(tracker.db, streamId);
      expect(children).toHaveLength(0);
    });

    it('should return all direct children', () => {
      const parentId = tracker.createStream({
        name: 'parent',
        agentId: 'agent-1',
      });

      const child1Id = tracker.createStream({
        name: 'child1',
        agentId: 'agent-1',
        parentStream: parentId,
        base: tracker.getStreamHead(parentId),
      });

      const child2Id = tracker.createStream({
        name: 'child2',
        agentId: 'agent-1',
        parentStream: parentId,
        base: tracker.getStreamHead(parentId),
      });

      const children = streams.getChildStreams(tracker.db, parentId);
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.id).sort()).toEqual([child1Id, child2Id].sort());
    });

    it('should not return grandchildren', () => {
      const grandpaId = tracker.createStream({
        name: 'grandpa',
        agentId: 'agent-1',
      });

      const parentId = tracker.createStream({
        name: 'parent',
        agentId: 'agent-1',
        parentStream: grandpaId,
        base: tracker.getStreamHead(grandpaId),
      });

      tracker.createStream({
        name: 'child',
        agentId: 'agent-1',
        parentStream: parentId,
        base: tracker.getStreamHead(parentId),
      });

      const grandpaChildren = streams.getChildStreams(tracker.db, grandpaId);
      expect(grandpaChildren).toHaveLength(1);
      expect(grandpaChildren[0].id).toBe(parentId);
    });
  });

  describe('recordMerge', () => {
    it('should record a merge event', () => {
      const sourceId = tracker.createStream({
        name: 'source',
        agentId: 'agent-1',
      });

      const targetId = tracker.createStream({
        name: 'target',
        agentId: 'agent-1',
      });

      const sourceCommit = tracker.getStreamHead(sourceId);
      const mergeCommit = tracker.getStreamHead(targetId); // Simplified for test

      const mergeId = streams.recordMerge(tracker.db, {
        sourceStreamId: sourceId,
        sourceCommit,
        targetStreamId: targetId,
        mergeCommit,
      });

      expect(mergeId).toMatch(/^[a-f0-9]{8}$/);

      const merge = streams.getStreamMerge(tracker.db, mergeId);
      expect(merge).not.toBeNull();
      expect(merge!.sourceStreamId).toBe(sourceId);
      expect(merge!.sourceCommit).toBe(sourceCommit);
      expect(merge!.targetStreamId).toBe(targetId);
      expect(merge!.mergeCommit).toBe(mergeCommit);
    });

    it('should record merge with metadata', () => {
      const sourceId = tracker.createStream({
        name: 'source',
        agentId: 'agent-1',
      });

      const targetId = tracker.createStream({
        name: 'target',
        agentId: 'agent-1',
      });

      const mergeId = streams.recordMerge(tracker.db, {
        sourceStreamId: sourceId,
        sourceCommit: tracker.getStreamHead(sourceId),
        targetStreamId: targetId,
        mergeCommit: tracker.getStreamHead(targetId),
        metadata: { reason: 'feature complete', mergedBy: 'agent-1' },
      });

      const merge = streams.getStreamMerge(tracker.db, mergeId);
      expect(merge!.metadata).toEqual({ reason: 'feature complete', mergedBy: 'agent-1' });
    });

    it('should throw when source stream does not exist', () => {
      const targetId = tracker.createStream({
        name: 'target',
        agentId: 'agent-1',
      });

      expect(() =>
        streams.recordMerge(tracker.db, {
          sourceStreamId: 'nonexistent',
          sourceCommit: 'abc123',
          targetStreamId: targetId,
          mergeCommit: 'def456',
        })
      ).toThrow();
    });

    it('should throw when target stream does not exist', () => {
      const sourceId = tracker.createStream({
        name: 'source',
        agentId: 'agent-1',
      });

      expect(() =>
        streams.recordMerge(tracker.db, {
          sourceStreamId: sourceId,
          sourceCommit: 'abc123',
          targetStreamId: 'nonexistent',
          mergeCommit: 'def456',
        })
      ).toThrow();
    });
  });

  describe('getStreamMerges', () => {
    it('should return empty array when no merges exist', () => {
      const streamId = tracker.createStream({
        name: 'unmerged',
        agentId: 'agent-1',
      });

      const merges = streams.getStreamMerges(tracker.db, streamId);
      expect(merges).toHaveLength(0);
    });

    it('should return merges where stream is source', () => {
      const sourceId = tracker.createStream({
        name: 'source',
        agentId: 'agent-1',
      });

      const target1Id = tracker.createStream({
        name: 'target1',
        agentId: 'agent-1',
      });

      const target2Id = tracker.createStream({
        name: 'target2',
        agentId: 'agent-1',
      });

      streams.recordMerge(tracker.db, {
        sourceStreamId: sourceId,
        sourceCommit: tracker.getStreamHead(sourceId),
        targetStreamId: target1Id,
        mergeCommit: tracker.getStreamHead(target1Id),
      });

      streams.recordMerge(tracker.db, {
        sourceStreamId: sourceId,
        sourceCommit: tracker.getStreamHead(sourceId),
        targetStreamId: target2Id,
        mergeCommit: tracker.getStreamHead(target2Id),
      });

      const merges = streams.getStreamMerges(tracker.db, sourceId, { asSource: true, asTarget: false });
      expect(merges).toHaveLength(2);
      expect(merges.every((m) => m.sourceStreamId === sourceId)).toBe(true);
    });

    it('should return merges where stream is target', () => {
      const source1Id = tracker.createStream({
        name: 'source1',
        agentId: 'agent-1',
      });

      const source2Id = tracker.createStream({
        name: 'source2',
        agentId: 'agent-1',
      });

      const targetId = tracker.createStream({
        name: 'target',
        agentId: 'agent-1',
      });

      streams.recordMerge(tracker.db, {
        sourceStreamId: source1Id,
        sourceCommit: tracker.getStreamHead(source1Id),
        targetStreamId: targetId,
        mergeCommit: tracker.getStreamHead(targetId),
      });

      streams.recordMerge(tracker.db, {
        sourceStreamId: source2Id,
        sourceCommit: tracker.getStreamHead(source2Id),
        targetStreamId: targetId,
        mergeCommit: tracker.getStreamHead(targetId),
      });

      const merges = streams.getStreamMerges(tracker.db, targetId, { asSource: false, asTarget: true });
      expect(merges).toHaveLength(2);
      expect(merges.every((m) => m.targetStreamId === targetId)).toBe(true);
    });

    it('should return merges in chronological order', async () => {
      const sourceId = tracker.createStream({
        name: 'source',
        agentId: 'agent-1',
      });

      const targetId = tracker.createStream({
        name: 'target',
        agentId: 'agent-1',
      });

      // Record two merges with a small delay
      streams.recordMerge(tracker.db, {
        sourceStreamId: sourceId,
        sourceCommit: 'commit1',
        targetStreamId: targetId,
        mergeCommit: 'merge1',
        metadata: { order: 1 },
      });

      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));

      streams.recordMerge(tracker.db, {
        sourceStreamId: sourceId,
        sourceCommit: 'commit2',
        targetStreamId: targetId,
        mergeCommit: 'merge2',
        metadata: { order: 2 },
      });

      const merges = streams.getStreamMerges(tracker.db, sourceId);
      expect(merges[0].metadata.order).toBe(1);
      expect(merges[1].metadata.order).toBe(2);
      expect(merges[0].createdAt).toBeLessThanOrEqual(merges[1].createdAt);
    });
  });

  describe('getMergesFromStream and getMergesIntoStream', () => {
    it('should filter merges by direction', () => {
      const streamA = tracker.createStream({ name: 'A', agentId: 'agent-1' });
      const streamB = tracker.createStream({ name: 'B', agentId: 'agent-1' });
      const streamC = tracker.createStream({ name: 'C', agentId: 'agent-1' });

      // A -> B (A is source, B is target)
      streams.recordMerge(tracker.db, {
        sourceStreamId: streamA,
        sourceCommit: 'a1',
        targetStreamId: streamB,
        mergeCommit: 'b1',
      });

      // C -> A (C is source, A is target)
      streams.recordMerge(tracker.db, {
        sourceStreamId: streamC,
        sourceCommit: 'c1',
        targetStreamId: streamA,
        mergeCommit: 'a2',
      });

      const fromA = streams.getMergesFromStream(tracker.db, streamA);
      expect(fromA).toHaveLength(1);
      expect(fromA[0].targetStreamId).toBe(streamB);

      const intoA = streams.getMergesIntoStream(tracker.db, streamA);
      expect(intoA).toHaveLength(1);
      expect(intoA[0].sourceStreamId).toBe(streamC);
    });
  });
});
