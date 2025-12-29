import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker } from '../src/tracker.js';
import { createTestRepo } from './setup.js';
import * as git from '../src/git/index.js';
import * as deps from '../src/dependencies.js';
import * as cascade from '../src/cascade.js';
import * as fs from 'fs';
import * as path from 'path';
import { DiamondDependencyError, CyclicDependencyError } from '../src/errors.js';

describe('Cascade Rebase', () => {
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

  describe('Dependency Graph', () => {
    it('should auto-add fork dependency when forking', () => {
      const parentId = tracker.createStream({
        name: 'parent',
        agentId: 'agent-1',
      });

      const childId = tracker.forkStream({
        parentStreamId: parentId,
        name: 'child',
        agentId: 'agent-1',
      });

      // Check fork dependency was added
      const dependencies = deps.getDependencies(tracker.db, childId);
      expect(dependencies).toContain(parentId);

      const depType = deps.getDependencyType(tracker.db, childId);
      expect(depType).toBe('fork');
    });

    it('should get dependents correctly', () => {
      const parentId = tracker.createStream({
        name: 'parent',
        agentId: 'agent-1',
      });

      const child1 = tracker.forkStream({
        parentStreamId: parentId,
        name: 'child1',
        agentId: 'agent-1',
      });

      const child2 = tracker.forkStream({
        parentStreamId: parentId,
        name: 'child2',
        agentId: 'agent-1',
      });

      const dependents = deps.getDependents(tracker.db, parentId);
      expect(dependents).toHaveLength(2);
      expect(dependents).toContain(child1);
      expect(dependents).toContain(child2);
    });

    it('should detect diamond dependencies', () => {
      const root = tracker.createStream({
        name: 'root',
        agentId: 'agent-1',
      });

      const branch1 = tracker.forkStream({
        parentStreamId: root,
        name: 'branch1',
        agentId: 'agent-1',
      });

      const branch2 = tracker.forkStream({
        parentStreamId: root,
        name: 'branch2',
        agentId: 'agent-1',
      });

      // Create a stream that depends on both branches (diamond)
      const merge = tracker.createStream({
        name: 'merge',
        agentId: 'agent-1',
      });

      deps.addMergeDependency(tracker.db, merge, [branch1, branch2]);

      expect(deps.isDiamondDependency(tracker.db, merge)).toBe(true);
      expect(deps.getDependencyType(tracker.db, merge)).toBe('merge');
    });

    it('should detect cycle and throw error', () => {
      const stream1 = tracker.createStream({
        name: 'stream1',
        agentId: 'agent-1',
      });

      const stream2 = tracker.createStream({
        name: 'stream2',
        agentId: 'agent-1',
      });

      // Add stream1 -> stream2 dependency
      deps.addDependency(tracker.db, stream1, stream2);

      // Adding stream2 -> stream1 would create a cycle
      expect(() => {
        deps.addDependency(tracker.db, stream2, stream1);
      }).toThrow(CyclicDependencyError);
    });
  });

  describe('Topological Sort', () => {
    it('should sort linear chain correctly', () => {
      const a = tracker.createStream({ name: 'A', agentId: 'agent-1' });
      const b = tracker.forkStream({ parentStreamId: a, name: 'B', agentId: 'agent-1' });
      const c = tracker.forkStream({ parentStreamId: b, name: 'C', agentId: 'agent-1' });

      // Sort all three
      const sorted = deps.topologicalSort(tracker.db, [a, b, c]);

      // A should come before B, B before C
      expect(sorted.indexOf(a)).toBeLessThan(sorted.indexOf(b));
      expect(sorted.indexOf(b)).toBeLessThan(sorted.indexOf(c));
    });

    it('should sort fan-out correctly', () => {
      const parent = tracker.createStream({ name: 'parent', agentId: 'agent-1' });
      const child1 = tracker.forkStream({ parentStreamId: parent, name: 'child1', agentId: 'agent-1' });
      const child2 = tracker.forkStream({ parentStreamId: parent, name: 'child2', agentId: 'agent-1' });
      const child3 = tracker.forkStream({ parentStreamId: parent, name: 'child3', agentId: 'agent-1' });

      const sorted = deps.topologicalSort(tracker.db, [parent, child1, child2, child3]);

      // Parent should come first
      expect(sorted[0]).toBe(parent);
    });

    it('should throw on cycle in provided set', () => {
      const a = tracker.createStream({ name: 'A', agentId: 'agent-1' });
      const b = tracker.createStream({ name: 'B', agentId: 'agent-1' });
      const c = tracker.createStream({ name: 'C', agentId: 'agent-1' });

      // Create cycle: A -> B -> C -> A
      deps.addDependency(tracker.db, a, b);
      deps.addDependency(tracker.db, b, c);

      // This would create the cycle
      expect(() => {
        deps.addDependency(tracker.db, c, a);
      }).toThrow(CyclicDependencyError);
    });
  });

  describe('Linear Chain Cascade', () => {
    it('should cascade rebase through linear chain (A → B → C)', () => {
      // Create linear chain: main -> A -> B -> C
      const streamA = tracker.createStream({ name: 'A', agentId: 'agent-1' });
      const streamB = tracker.forkStream({ parentStreamId: streamA, name: 'B', agentId: 'agent-1' });
      const streamC = tracker.forkStream({ parentStreamId: streamB, name: 'C', agentId: 'agent-1' });

      // Make commit on each stream
      git.checkout(`stream/${streamA}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'a.txt'), 'content-a');
      git.stageAll({ cwd: testRepo.path });
      git.commit('commit A', { cwd: testRepo.path });

      git.checkout(`stream/${streamB}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'b.txt'), 'content-b');
      git.stageAll({ cwd: testRepo.path });
      git.commit('commit B', { cwd: testRepo.path });

      git.checkout(`stream/${streamC}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'c.txt'), 'content-c');
      git.stageAll({ cwd: testRepo.path });
      git.commit('commit C', { cwd: testRepo.path });

      // Record initial heads
      const initialHeadB = git.resolveRef(`stream/${streamB}`, { cwd: testRepo.path });
      const initialHeadC = git.resolveRef(`stream/${streamC}`, { cwd: testRepo.path });

      // Make another commit on A
      git.checkout(`stream/${streamA}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'a2.txt'), 'content-a2');
      git.stageAll({ cwd: testRepo.path });
      git.commit('commit A2', { cwd: testRepo.path });

      // Rebase B onto A (should trigger cascade to C)
      const result = tracker.rebaseOntoStream({
        sourceStream: streamB,
        targetStream: streamA,
        agentId: 'agent-1',
        worktree: testRepo.path,
      });

      expect(result.success).toBe(true);
      expect(result.cascadeResult).toBeDefined();
      expect(result.cascadeResult!.success).toBe(true);
      expect(result.cascadeResult!.updated).toContain(streamC);

      // Verify heads have changed
      const newHeadB = git.resolveRef(`stream/${streamB}`, { cwd: testRepo.path });
      const newHeadC = git.resolveRef(`stream/${streamC}`, { cwd: testRepo.path });

      expect(newHeadB).not.toBe(initialHeadB);
      expect(newHeadC).not.toBe(initialHeadC);

      // Verify C has content from A
      git.checkout(`stream/${streamC}`, { cwd: testRepo.path });
      expect(fs.existsSync(path.join(testRepo.path, 'a2.txt'))).toBe(true);
    });
  });

  describe('Fan-out Cascade', () => {
    it('should cascade to all children (A → B, C, D)', () => {
      // Create fan-out: main -> A -> (B, C, D)
      const streamA = tracker.createStream({ name: 'A', agentId: 'agent-1' });
      const streamB = tracker.forkStream({ parentStreamId: streamA, name: 'B', agentId: 'agent-1' });
      const streamC = tracker.forkStream({ parentStreamId: streamA, name: 'C', agentId: 'agent-1' });
      const streamD = tracker.forkStream({ parentStreamId: streamA, name: 'D', agentId: 'agent-1' });

      // Make commit on A
      git.checkout(`stream/${streamA}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'a.txt'), 'content-a');
      git.stageAll({ cwd: testRepo.path });
      git.commit('commit A', { cwd: testRepo.path });

      // Make commits on children
      for (const streamId of [streamB, streamC, streamD]) {
        git.checkout(`stream/${streamId}`, { cwd: testRepo.path });
        fs.writeFileSync(path.join(testRepo.path, `${streamId}.txt`), `content-${streamId}`);
        git.stageAll({ cwd: testRepo.path });
        git.commit(`commit ${streamId}`, { cwd: testRepo.path });
      }

      // Make another commit on A
      git.checkout(`stream/${streamA}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'a2.txt'), 'content-a2');
      git.stageAll({ cwd: testRepo.path });
      git.commit('commit A2', { cwd: testRepo.path });

      // Trigger cascade from A (we need a rebase that triggers cascade)
      // Since A has no parent dependency, we'll directly call cascadeRebase
      const cascadeResult = cascade.cascadeRebase(tracker.db, testRepo.path, {
        rootStream: streamA,
        agentId: 'agent-1',
        worktree: {
          mode: 'sequential',
          worktreePath: testRepo.path,
        },
        strategy: 'stop_on_conflict',
      });

      expect(cascadeResult.success).toBe(true);
      expect(cascadeResult.updated).toHaveLength(3);
      expect(cascadeResult.updated).toContain(streamB);
      expect(cascadeResult.updated).toContain(streamC);
      expect(cascadeResult.updated).toContain(streamD);
    });
  });

  describe('Diamond Detection', () => {
    it('should throw DiamondDependencyError for merge streams', () => {
      const root = tracker.createStream({ name: 'root', agentId: 'agent-1' });
      const branch1 = tracker.forkStream({ parentStreamId: root, name: 'branch1', agentId: 'agent-1' });
      const branch2 = tracker.forkStream({ parentStreamId: root, name: 'branch2', agentId: 'agent-1' });

      // Create stream with diamond dependency
      const diamond = tracker.createStream({ name: 'diamond', agentId: 'agent-1' });
      deps.addMergeDependency(tracker.db, diamond, [branch1, branch2]);

      // Make commit on root
      git.checkout(`stream/${root}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'root.txt'), 'content');
      git.stageAll({ cwd: testRepo.path });
      git.commit('root commit', { cwd: testRepo.path });

      // Cascade should throw for diamond
      expect(() => {
        cascade.cascadeRebase(tracker.db, testRepo.path, {
          rootStream: root,
          agentId: 'agent-1',
          worktree: {
            mode: 'sequential',
            worktreePath: testRepo.path,
          },
        });
      }).toThrow(DiamondDependencyError);
    });
  });

  describe('Cascade Strategies', () => {
    it('should stop on first conflict with stop_on_conflict strategy', () => {
      // Create chain where conflict will occur
      const streamA = tracker.createStream({ name: 'A', agentId: 'agent-1' });
      const streamB = tracker.forkStream({ parentStreamId: streamA, name: 'B', agentId: 'agent-1' });
      const streamC = tracker.forkStream({ parentStreamId: streamB, name: 'C', agentId: 'agent-1' });

      // Create conflicting content
      git.checkout(`stream/${streamA}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'conflict.txt'), 'content-from-a');
      git.stageAll({ cwd: testRepo.path });
      git.commit('commit A', { cwd: testRepo.path });

      git.checkout(`stream/${streamB}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'conflict.txt'), 'content-from-b');
      git.stageAll({ cwd: testRepo.path });
      git.commit('commit B', { cwd: testRepo.path });

      git.checkout(`stream/${streamC}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'other.txt'), 'content-c');
      git.stageAll({ cwd: testRepo.path });
      git.commit('commit C', { cwd: testRepo.path });

      // Now change A in a conflicting way
      git.checkout(`stream/${streamA}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'conflict.txt'), 'different-content-from-a');
      git.stageAll({ cwd: testRepo.path });
      git.commit('commit A conflict', { cwd: testRepo.path });

      // Cascade should fail at B and stop
      const result = cascade.cascadeRebase(tracker.db, testRepo.path, {
        rootStream: streamA,
        agentId: 'agent-1',
        worktree: {
          mode: 'sequential',
          worktreePath: testRepo.path,
        },
        strategy: 'stop_on_conflict',
      });

      expect(result.success).toBe(false);
      expect(result.failed).toContain(streamB);
      // C should not be in updated because we stopped at B
      expect(result.updated).not.toContain(streamC);
    });

    it('should continue with skip_conflicting strategy', () => {
      // Create two independent children from A
      const streamA = tracker.createStream({ name: 'A', agentId: 'agent-1' });
      const streamB = tracker.forkStream({ parentStreamId: streamA, name: 'B', agentId: 'agent-1' });
      const streamC = tracker.forkStream({ parentStreamId: streamA, name: 'C', agentId: 'agent-1' });

      // Create conflicting content in B
      git.checkout(`stream/${streamA}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'conflict.txt'), 'content-from-a');
      git.stageAll({ cwd: testRepo.path });
      git.commit('commit A', { cwd: testRepo.path });

      git.checkout(`stream/${streamB}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'conflict.txt'), 'content-from-b');
      git.stageAll({ cwd: testRepo.path });
      git.commit('commit B', { cwd: testRepo.path });

      // C doesn't conflict
      git.checkout(`stream/${streamC}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'c-only.txt'), 'content-c');
      git.stageAll({ cwd: testRepo.path });
      git.commit('commit C', { cwd: testRepo.path });

      // Now change A in a way that conflicts with B but not C
      git.checkout(`stream/${streamA}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'conflict.txt'), 'different-content-from-a');
      git.stageAll({ cwd: testRepo.path });
      git.commit('commit A conflict', { cwd: testRepo.path });

      // Cascade with skip_conflicting should fail B but succeed C
      const result = cascade.cascadeRebase(tracker.db, testRepo.path, {
        rootStream: streamA,
        agentId: 'agent-1',
        worktree: {
          mode: 'sequential',
          worktreePath: testRepo.path,
        },
        strategy: 'skip_conflicting',
      });

      expect(result.success).toBe(false); // Overall failed because B failed
      expect(result.failed).toContain(streamB);
      expect(result.updated).toContain(streamC);
    });
  });

  describe('Cascade Opt-out', () => {
    it('should not cascade when cascade=false', () => {
      const streamA = tracker.createStream({ name: 'A', agentId: 'agent-1' });
      const streamB = tracker.forkStream({ parentStreamId: streamA, name: 'B', agentId: 'agent-1' });

      // Make commits
      git.checkout(`stream/${streamA}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'a.txt'), 'content-a');
      git.stageAll({ cwd: testRepo.path });
      git.commit('commit A', { cwd: testRepo.path });

      git.checkout(`stream/${streamB}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'b.txt'), 'content-b');
      git.stageAll({ cwd: testRepo.path });
      git.commit('commit B', { cwd: testRepo.path });

      const initialHeadB = git.resolveRef(`stream/${streamB}`, { cwd: testRepo.path });

      // Make another commit on A
      git.checkout(`stream/${streamA}`, { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'a2.txt'), 'content-a2');
      git.stageAll({ cwd: testRepo.path });
      git.commit('commit A2', { cwd: testRepo.path });

      // Create a parent for A so we can rebase
      const main = 'main';

      // Rebase A onto main with cascade=false
      const result = tracker.rebaseOntoStream({
        sourceStream: streamA,
        targetStream: streamA, // Rebase onto itself (no-op for A, but might trigger cascade)
        agentId: 'agent-1',
        worktree: testRepo.path,
        cascade: false,
      });

      // Since cascade=false, B should not be updated
      expect(result.cascadeResult).toBeUndefined();

      const newHeadB = git.resolveRef(`stream/${streamB}`, { cwd: testRepo.path });
      expect(newHeadB).toBe(initialHeadB);
    });
  });
});
