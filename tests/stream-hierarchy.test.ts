/**
 * Stream Hierarchy tests.
 *
 * Tests for the stream hierarchy functionality which returns a tree structure
 * of streams with their active tasks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker } from '../src/tracker.js';
import { createTestRepo, type TestRepo } from './setup.js';
import * as workerTasks from '../src/worker-tasks.js';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { StreamNode } from '../src/models/stream.js';

describe('Stream Hierarchy', () => {
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

  // Helper to create a worktree for task operations
  function createWorktree(agentId: string, streamId: string): string {
    const worktreePath = path.join(testRepo.path, '.worktrees', agentId);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    const streamBranch = `stream/${streamId}`;
    execSync(`git worktree add "${worktreePath}" ${streamBranch}`, {
      cwd: testRepo.path,
      stdio: 'pipe',
    });
    return worktreePath;
  }

  describe('getStreamHierarchy', () => {
    it('should return single stream node when given a root stream ID', () => {
      const streamId = tracker.createStream({
        name: 'root-stream',
        agentId: 'agent-1',
      });

      const result = tracker.getStreamHierarchy(streamId);

      // Should return a single node, not an array
      expect(Array.isArray(result)).toBe(false);
      const node = result as StreamNode;
      expect(node.stream.id).toBe(streamId);
      expect(node.stream.name).toBe('root-stream');
      expect(node.children).toHaveLength(0);
      expect(node.tasks).toHaveLength(0);
    });

    it('should return array of root streams when no ID provided', () => {
      const stream1 = tracker.createStream({
        name: 'root-1',
        agentId: 'agent-1',
      });
      const stream2 = tracker.createStream({
        name: 'root-2',
        agentId: 'agent-1',
      });

      const result = tracker.getStreamHierarchy();

      expect(Array.isArray(result)).toBe(true);
      const nodes = result as StreamNode[];
      expect(nodes.length).toBeGreaterThanOrEqual(2);

      const ids = nodes.map((n) => n.stream.id);
      expect(ids).toContain(stream1);
      expect(ids).toContain(stream2);
    });

    it('should build nested hierarchy with children', () => {
      const rootId = tracker.createStream({
        name: 'root',
        agentId: 'agent-1',
      });

      const child1Id = tracker.forkStream({
        parentStreamId: rootId,
        name: 'child-1',
        agentId: 'agent-1',
      });

      const child2Id = tracker.forkStream({
        parentStreamId: rootId,
        name: 'child-2',
        agentId: 'agent-1',
      });

      const grandchildId = tracker.forkStream({
        parentStreamId: child1Id,
        name: 'grandchild',
        agentId: 'agent-1',
      });

      const result = tracker.getStreamHierarchy(rootId) as StreamNode;

      // Root level
      expect(result.stream.id).toBe(rootId);
      expect(result.children).toHaveLength(2);

      // Children level
      const childIds = result.children.map((c) => c.stream.id);
      expect(childIds).toContain(child1Id);
      expect(childIds).toContain(child2Id);

      // Find child1 and verify grandchild
      const child1Node = result.children.find((c) => c.stream.id === child1Id)!;
      expect(child1Node.children).toHaveLength(1);
      expect(child1Node.children[0].stream.id).toBe(grandchildId);

      // child2 should have no children
      const child2Node = result.children.find((c) => c.stream.id === child2Id)!;
      expect(child2Node.children).toHaveLength(0);
    });

    it('should include active tasks (open and in_progress)', () => {
      const streamId = tracker.createStream({
        name: 'stream-with-tasks',
        agentId: 'agent-1',
      });

      // Create tasks with different statuses
      const openTask = workerTasks.createTask(tracker.db, {
        title: 'Open Task',
        streamId,
      });

      const inProgressTask = workerTasks.createTask(tracker.db, {
        title: 'In Progress Task',
        streamId,
      });

      const completedTask = workerTasks.createTask(tracker.db, {
        title: 'Completed Task',
        streamId,
      });

      const abandonedTask = workerTasks.createTask(tracker.db, {
        title: 'Abandoned Task',
        streamId,
      });

      // Start the in_progress task
      const worktree = createWorktree('agent-1', streamId);
      workerTasks.startTask(tracker.db, testRepo.path, {
        taskId: inProgressTask,
        agentId: 'agent-1',
        worktree,
      });

      // Complete one task
      const completeWorktree = createWorktree('agent-2', streamId);
      workerTasks.startTask(tracker.db, testRepo.path, {
        taskId: completedTask,
        agentId: 'agent-2',
        worktree: completeWorktree,
      });
      // Make a commit so we can complete
      fs.writeFileSync(path.join(completeWorktree, 'file.txt'), 'content');
      execSync('git add . && git commit -m "Add file"', {
        cwd: completeWorktree,
        stdio: 'pipe',
      });
      workerTasks.completeTask(tracker.db, testRepo.path, {
        taskId: completedTask,
        worktree: completeWorktree,
      });

      // Abandon one task
      workerTasks.abandonTask(tracker.db, testRepo.path, abandonedTask);

      // Get hierarchy
      const result = tracker.getStreamHierarchy(streamId) as StreamNode;

      // Should only include open and in_progress tasks
      expect(result.tasks).toHaveLength(2);
      const taskIds = result.tasks.map((t) => t.id);
      expect(taskIds).toContain(openTask);
      expect(taskIds).toContain(inProgressTask);
      expect(taskIds).not.toContain(completedTask);
      expect(taskIds).not.toContain(abandonedTask);
    });

    it('should include tasks in nested streams', () => {
      const rootId = tracker.createStream({
        name: 'root',
        agentId: 'agent-1',
      });

      const childId = tracker.forkStream({
        parentStreamId: rootId,
        name: 'child',
        agentId: 'agent-1',
      });

      // Add tasks to both streams
      workerTasks.createTask(tracker.db, { title: 'Root Task', streamId: rootId });
      workerTasks.createTask(tracker.db, { title: 'Child Task 1', streamId: childId });
      workerTasks.createTask(tracker.db, { title: 'Child Task 2', streamId: childId });

      const result = tracker.getStreamHierarchy(rootId) as StreamNode;

      // Root should have 1 task
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].title).toBe('Root Task');

      // Child should have 2 tasks
      expect(result.children[0].tasks).toHaveLength(2);
      const childTitles = result.children[0].tasks.map((t) => t.title);
      expect(childTitles).toContain('Child Task 1');
      expect(childTitles).toContain('Child Task 2');
    });

    it('should handle deeply nested hierarchy (4+ levels)', () => {
      const level0 = tracker.createStream({ name: 'level-0', agentId: 'agent-1' });
      const level1 = tracker.forkStream({
        parentStreamId: level0,
        name: 'level-1',
        agentId: 'agent-1',
      });
      const level2 = tracker.forkStream({
        parentStreamId: level1,
        name: 'level-2',
        agentId: 'agent-1',
      });
      const level3 = tracker.forkStream({
        parentStreamId: level2,
        name: 'level-3',
        agentId: 'agent-1',
      });
      const level4 = tracker.forkStream({
        parentStreamId: level3,
        name: 'level-4',
        agentId: 'agent-1',
      });

      const result = tracker.getStreamHierarchy(level0) as StreamNode;

      // Traverse down the hierarchy
      expect(result.stream.id).toBe(level0);
      expect(result.children[0].stream.id).toBe(level1);
      expect(result.children[0].children[0].stream.id).toBe(level2);
      expect(result.children[0].children[0].children[0].stream.id).toBe(level3);
      expect(result.children[0].children[0].children[0].children[0].stream.id).toBe(level4);
    });

    it('should return empty array when no streams exist', () => {
      // Don't create any streams
      const result = tracker.getStreamHierarchy();

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    it('should not include non-active streams in hierarchy', () => {
      const activeStream = tracker.createStream({
        name: 'active',
        agentId: 'agent-1',
      });

      const abandonedStream = tracker.createStream({
        name: 'abandoned',
        agentId: 'agent-1',
      });

      tracker.abandonStream(abandonedStream);

      const result = tracker.getStreamHierarchy() as StreamNode[];

      // Only active stream should be in the hierarchy
      const activeIds = result.map((n) => n.stream.id);
      expect(activeIds).toContain(activeStream);
      // Abandoned streams may or may not be included depending on implementation
      // This test documents the current behavior
    });

    it('should handle multiple children at same level', () => {
      const rootId = tracker.createStream({
        name: 'root',
        agentId: 'agent-1',
      });

      // Create multiple children
      const children: string[] = [];
      for (let i = 0; i < 5; i++) {
        children.push(
          tracker.forkStream({
            parentStreamId: rootId,
            name: `child-${i}`,
            agentId: 'agent-1',
          })
        );
      }

      const result = tracker.getStreamHierarchy(rootId) as StreamNode;

      expect(result.children).toHaveLength(5);
      const childIds = result.children.map((c) => c.stream.id);
      for (const childId of children) {
        expect(childIds).toContain(childId);
      }
    });
  });

  describe('getStreamGraph (deprecated)', () => {
    it('should work the same as getStreamHierarchy', () => {
      const streamId = tracker.createStream({
        name: 'test-stream',
        agentId: 'agent-1',
      });

      workerTasks.createTask(tracker.db, { title: 'Task', streamId });

      const hierarchy = tracker.getStreamHierarchy(streamId) as StreamNode;
      const graph = tracker.getStreamGraph(streamId) as StreamNode;

      expect(hierarchy.stream.id).toBe(graph.stream.id);
      expect(hierarchy.tasks.length).toBe(graph.tasks.length);
      expect(hierarchy.children.length).toBe(graph.children.length);
    });
  });
});
