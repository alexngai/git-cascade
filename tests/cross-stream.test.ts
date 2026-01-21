import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker } from '../src/tracker.js';
import { createTestRepo } from './setup.js';
import * as git from '../src/git/index.js';
import * as workerTasks from '../src/worker-tasks.js';
import * as fs from 'fs';
import * as path from 'path';

describe('Cross-Stream Operations', () => {
  let tracker: MultiAgentRepoTracker;
  let testRepo: ReturnType<typeof createTestRepo>;

  beforeEach(() => {
    testRepo = createTestRepo();
    tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });
  });

  afterEach(() => {
    tracker.close();
    testRepo.cleanup();
  });

  // Helper to create a commit
  function makeCommit(message: string, worktree: string = testRepo.path): string {
    const filePath = path.join(worktree, `file-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(filePath, `content for ${message}`);
    git.stageAll({ cwd: worktree });
    return git.commit(message, { cwd: worktree });
  }

  describe('rebaseOntoStream', () => {
    it('should rebase stream onto another stream (no conflicts)', () => {
      // Create parent stream
      const parentId = tracker.createStream({
        name: 'parent',
        agentId: 'agent-1',
      });

      // Fork child stream
      const childId = tracker.forkStream({
        parentStreamId: parentId,
        name: 'child',
        agentId: 'agent-1',
      });

      // Make commits on parent
      git.checkout(`stream/${parentId}`, { cwd: testRepo.path });
      makeCommit('Parent commit 1');
      const parentHead = makeCommit('Parent commit 2');

      // Make commits on child
      git.checkout(`stream/${childId}`, { cwd: testRepo.path });
      makeCommit('Child commit');

      // Rebase child onto parent
      const result = tracker.rebaseOntoStream({
        sourceStream: childId,
        targetStream: parentId,
        agentId: 'agent-1',
        worktree: testRepo.path,
      });

      expect(result.success).toBe(true);
      expect(result.newBaseCommit).toBe(parentHead);

      // Verify child's base commit updated
      const child = tracker.getStream(childId);
      expect(child!.baseCommit).toBe(parentHead);
    });

    it('should update baseCommit when stream has no commits', () => {
      // Create parent stream
      const parentId = tracker.createStream({
        name: 'parent',
        agentId: 'agent-1',
      });

      // Fork child stream (no commits)
      const childId = tracker.forkStream({
        parentStreamId: parentId,
        name: 'child',
        agentId: 'agent-1',
      });

      // Make commits on parent
      git.checkout(`stream/${parentId}`, { cwd: testRepo.path });
      const parentHead = makeCommit('Parent commit');

      // Rebase child onto parent (fast-forward)
      const result = tracker.rebaseOntoStream({
        sourceStream: childId,
        targetStream: parentId,
        agentId: 'agent-1',
        worktree: testRepo.path,
      });

      expect(result.success).toBe(true);
      expect(result.newHead).toBe(parentHead);
    });
  });

  describe('syncWithParent', () => {
    it('should sync stream with parent', () => {
      // Create parent stream
      const parentId = tracker.createStream({
        name: 'parent',
        agentId: 'agent-1',
      });

      // Fork child stream
      const childId = tracker.forkStream({
        parentStreamId: parentId,
        name: 'child',
        agentId: 'agent-1',
      });

      // Make commits on parent
      git.checkout(`stream/${parentId}`, { cwd: testRepo.path });
      const parentHead = makeCommit('Parent update');

      // Make commit on child
      git.checkout(`stream/${childId}`, { cwd: testRepo.path });
      makeCommit('Child work');

      // Sync with parent
      const result = tracker.syncWithParent(childId, 'agent-1', testRepo.path);

      expect(result.success).toBe(true);
      expect(result.newBaseCommit).toBe(parentHead);
    });

    it('should error when stream has no parent', () => {
      const streamId = tracker.createStream({
        name: 'orphan',
        agentId: 'agent-1',
      });

      expect(() => {
        tracker.syncWithParent(streamId, 'agent-1', testRepo.path);
      }).toThrow('has no parent stream');
    });
  });

  describe('Dependency Tracking', () => {
    it('should add and get dependencies', () => {
      const stream1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const stream2 = tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });

      tracker.addDependency(stream1, stream2);

      const deps = tracker.getDependencies(stream1);
      expect(deps).toContain(stream2);
    });

    it('should get dependents (reverse lookup)', () => {
      const stream1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const stream2 = tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });

      tracker.addDependency(stream1, stream2);

      const dependents = tracker.getDependents(stream2);
      expect(dependents).toContain(stream1);
    });

    it('should remove dependencies', () => {
      const stream1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });
      const stream2 = tracker.createStream({ name: 'stream-2', agentId: 'agent-1' });

      tracker.addDependency(stream1, stream2);
      tracker.removeDependency(stream1, stream2);

      const deps = tracker.getDependencies(stream1);
      expect(deps).not.toContain(stream2);
    });

    it('should prevent self-dependency', () => {
      const stream = tracker.createStream({ name: 'stream', agentId: 'agent-1' });

      expect(() => {
        tracker.addDependency(stream, stream);
      }).toThrow('would create a cycle');
    });

    it('should prevent simple cycle A -> B -> A', () => {
      const streamA = tracker.createStream({ name: 'stream-a', agentId: 'agent-1' });
      const streamB = tracker.createStream({ name: 'stream-b', agentId: 'agent-1' });

      tracker.addDependency(streamA, streamB);

      expect(() => {
        tracker.addDependency(streamB, streamA);
      }).toThrow('would create a cycle');
    });

    it('should prevent longer cycle A -> B -> C -> A', () => {
      const streamA = tracker.createStream({ name: 'stream-a', agentId: 'agent-1' });
      const streamB = tracker.createStream({ name: 'stream-b', agentId: 'agent-1' });
      const streamC = tracker.createStream({ name: 'stream-c', agentId: 'agent-1' });

      tracker.addDependency(streamA, streamB);
      tracker.addDependency(streamB, streamC);

      expect(() => {
        tracker.addDependency(streamC, streamA);
      }).toThrow('would create a cycle');
    });
  });

  describe('Stream Graph Queries', () => {
    it('should get child streams', () => {
      const parentId = tracker.createStream({
        name: 'parent',
        agentId: 'agent-1',
      });

      const child1Id = tracker.forkStream({
        parentStreamId: parentId,
        name: 'child-1',
        agentId: 'agent-1',
      });

      const child2Id = tracker.forkStream({
        parentStreamId: parentId,
        name: 'child-2',
        agentId: 'agent-1',
      });

      const children = tracker.getChildStreams(parentId);
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.id)).toContain(child1Id);
      expect(children.map((c) => c.id)).toContain(child2Id);
    });

    it('should return empty for leaf streams', () => {
      const streamId = tracker.createStream({
        name: 'leaf',
        agentId: 'agent-1',
      });

      const children = tracker.getChildStreams(streamId);
      expect(children).toHaveLength(0);
    });

    it('should find common ancestor between sibling streams', () => {
      const parentId = tracker.createStream({
        name: 'parent',
        agentId: 'agent-1',
      });

      git.checkout(`stream/${parentId}`, { cwd: testRepo.path });
      const baseCommit = makeCommit('Base commit');

      const child1Id = tracker.forkStream({
        parentStreamId: parentId,
        name: 'child-1',
        agentId: 'agent-1',
      });

      const child2Id = tracker.forkStream({
        parentStreamId: parentId,
        name: 'child-2',
        agentId: 'agent-1',
      });

      // Make commits on children
      git.checkout(`stream/${child1Id}`, { cwd: testRepo.path });
      makeCommit('Child 1 commit');

      git.checkout(`stream/${child2Id}`, { cwd: testRepo.path });
      makeCommit('Child 2 commit');

      const ancestor = tracker.findCommonAncestor(child1Id, child2Id);
      expect(ancestor).toBe(baseCommit);
    });

    it('should build stream graph from root', () => {
      const rootId = tracker.createStream({
        name: 'root',
        agentId: 'agent-1',
      });

      const child1Id = tracker.forkStream({
        parentStreamId: rootId,
        name: 'child-1',
        agentId: 'agent-1',
      });

      const grandchildId = tracker.forkStream({
        parentStreamId: child1Id,
        name: 'grandchild',
        agentId: 'agent-1',
      });

      const graph = tracker.getStreamGraph(rootId);

      // Should be a single node (not array)
      expect(Array.isArray(graph)).toBe(false);
      const rootNode = graph as { stream: { id: string }; children: unknown[] };

      expect(rootNode.stream.id).toBe(rootId);
      expect(rootNode.children).toHaveLength(1);

      const child1Node = rootNode.children[0] as { stream: { id: string }; children: unknown[] };
      expect(child1Node.stream.id).toBe(child1Id);
      expect(child1Node.children).toHaveLength(1);

      const grandchildNode = child1Node.children[0] as { stream: { id: string } };
      expect(grandchildNode.stream.id).toBe(grandchildId);
    });

    it('should include active tasks in stream hierarchy', () => {
      const stream1 = tracker.createStream({ name: 'stream-1', agentId: 'agent-1' });

      // Create tasks for the stream
      workerTasks.createTask(tracker.db, { title: 'Task 1', streamId: stream1 });
      workerTasks.createTask(tracker.db, { title: 'Task 2', streamId: stream1 });

      const graph = tracker.getStreamHierarchy(stream1);
      const node = graph as { tasks: Array<{ title: string }> };

      expect(node.tasks).toHaveLength(2);
      expect(node.tasks.map((t) => t.title)).toContain('Task 1');
      expect(node.tasks.map((t) => t.title)).toContain('Task 2');
    });
  });
});
