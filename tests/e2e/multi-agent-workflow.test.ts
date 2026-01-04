/**
 * End-to-End Tests: Multi-Agent Workflow
 *
 * Tests complete multi-agent scenarios from stream creation through
 * merge, archive, and cleanup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { MultiAgentRepoTracker } from '../../src/index.js';
import { createTestRepo, type TestRepo } from '../setup.js';

describe('E2E: Multi-Agent Workflow', () => {
  let testRepo: TestRepo;
  let tracker: MultiAgentRepoTracker;

  beforeEach(() => {
    testRepo = createTestRepo();
    tracker = new MultiAgentRepoTracker({
      repoPath: testRepo.path,
      skipRecovery: true,
    });
  });

  afterEach(() => {
    tracker.close();
    testRepo.cleanup();
  });

  describe('Complete Feature Development Lifecycle', () => {
    it('should handle full multi-agent feature development workflow', () => {
      // === PHASE 1: Agent A creates a feature stream ===
      const agentA = 'agent-alpha';
      const worktreeA = path.join(testRepo.path, '.worktrees', agentA);

      const streamA = tracker.createStream({
        name: 'feature-auth',
        agentId: agentA,
        enableStackedReview: true,
      });

      tracker.createWorktree({
        agentId: agentA,
        path: worktreeA,
        branch: `stream/${streamA}`,
      });

      // Agent A makes commits
      fs.writeFileSync(path.join(worktreeA, 'auth.ts'), 'export function login() {}');
      execSync('git add .', { cwd: worktreeA, stdio: 'pipe' });
      const commitA1 = tracker.commitChanges({
        streamId: streamA,
        message: 'feat: add login function',
        agentId: agentA,
        worktree: worktreeA,
      });

      fs.writeFileSync(path.join(worktreeA, 'auth.ts'), 'export function login() {}\nexport function logout() {}');
      execSync('git add .', { cwd: worktreeA, stdio: 'pipe' });
      const commitA2 = tracker.commitChanges({
        streamId: streamA,
        message: 'feat: add logout function',
        agentId: agentA,
        worktree: worktreeA,
      });

      // Verify commits have Change-Id
      const changesA = tracker.getChangesForStream(streamA);
      expect(changesA.length).toBe(2);
      expect(changesA.every(c => c.id.startsWith('c-'))).toBe(true);

      // === PHASE 2: Agent B forks from Agent A ===
      const agentB = 'agent-beta';
      const worktreeB = path.join(testRepo.path, '.worktrees', agentB);

      const streamB = tracker.forkStream({
        parentStreamId: streamA,
        name: 'feature-auth-tests',
        agentId: agentB,
      });

      tracker.createWorktree({
        agentId: agentB,
        path: worktreeB,
        branch: `stream/${streamB}`,
      });

      // Agent B adds tests
      fs.writeFileSync(path.join(worktreeB, 'auth.test.ts'), 'test("login works", () => {});');
      execSync('git add .', { cwd: worktreeB, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: streamB,
        message: 'test: add login test',
        agentId: agentB,
        worktree: worktreeB,
      });

      fs.writeFileSync(path.join(worktreeB, 'auth.test.ts'), 'test("login works", () => {});\ntest("logout works", () => {});');
      execSync('git add .', { cwd: worktreeB, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: streamB,
        message: 'test: add logout test',
        agentId: agentB,
        worktree: worktreeB,
      });

      // === PHASE 3: Agent A makes more changes (triggers need for sync) ===
      fs.writeFileSync(path.join(worktreeA, 'auth.ts'),
        'export function login() {}\nexport function logout() {}\nexport function refresh() {}');
      execSync('git add .', { cwd: worktreeA, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: streamA,
        message: 'feat: add token refresh',
        agentId: agentA,
        worktree: worktreeA,
      });

      // === PHASE 4: Agent B syncs with parent (cascade rebase) ===
      const syncResult = tracker.syncWithParent(streamB, agentB, worktreeB);
      expect(syncResult.success).toBe(true);

      // Verify B now has A's latest changes
      const authContent = fs.readFileSync(path.join(worktreeB, 'auth.ts'), 'utf-8');
      expect(authContent).toContain('refresh()');

      // Changes should be preserved
      const changesB = tracker.getChangesForStream(streamB);
      expect(changesB.length).toBe(2);

      // === PHASE 5: Create review blocks for stacked review ===
      const stackA = tracker.getStack(streamA);
      expect(stackA.length).toBe(0); // Not auto-populated

      // Auto-populate the stack
      tracker.autoPopulateStack(streamA);
      const populatedStack = tracker.getStack(streamA);
      expect(populatedStack.length).toBeGreaterThan(0);

      // Set review status
      tracker.setReviewStatus({
        reviewBlockId: populatedStack[0].id,
        status: 'approved',
        reviewerId: 'reviewer-1',
      });

      // === PHASE 6: Merge stream B back to A ===
      const mergeResult = tracker.mergeStream({
        sourceStream: streamB,
        targetStream: streamA,
        agentId: agentA,
        worktree: worktreeA,
        strategy: 'merge-commit',
      });
      expect(mergeResult.success).toBe(true);

      // Verify merged content
      const mergedAuth = fs.readFileSync(path.join(worktreeA, 'auth.ts'), 'utf-8');
      expect(mergedAuth).toContain('refresh()');
      expect(fs.existsSync(path.join(worktreeA, 'auth.test.ts'))).toBe(true);

      // Stream B should be marked as merged
      const streamBAfter = tracker.getStream(streamB);
      expect(streamBAfter?.status).toBe('merged');

      // === PHASE 7: Verify operations log ===
      const opsA = tracker.getOperations({ streamId: streamA });
      const opsB = tracker.getOperations({ streamId: streamB });

      expect(opsA.length).toBeGreaterThan(0);
      expect(opsB.length).toBeGreaterThan(0);

      // Should have commit and rebase operations
      const opTypes = [...opsA, ...opsB].map(op => op.opType);
      expect(opTypes).toContain('commit');

      // === PHASE 8: Health check ===
      const health = tracker.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.streamCount).toBe(2);
    });

    it('should handle parallel agent work with dependency tracking', () => {
      const agent1 = 'agent-1';
      const agent2 = 'agent-2';
      const agent3 = 'agent-3';

      // Create base stream
      const baseStream = tracker.createStream({
        name: 'base-feature',
        agentId: agent1,
      });

      const wt1 = path.join(testRepo.path, '.worktrees', agent1);
      tracker.createWorktree({ agentId: agent1, path: wt1, branch: `stream/${baseStream}` });

      fs.writeFileSync(path.join(wt1, 'base.ts'), 'export const VERSION = 1;');
      execSync('git add .', { cwd: wt1, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: baseStream,
        message: 'feat: add base module',
        agentId: agent1,
        worktree: wt1,
      });

      // Fork two parallel streams
      const streamA = tracker.forkStream({
        parentStreamId: baseStream,
        name: 'feature-a',
        agentId: agent2,
      });

      const streamB = tracker.forkStream({
        parentStreamId: baseStream,
        name: 'feature-b',
        agentId: agent3,
      });

      // Both have dependency on base
      const depsA = tracker.getDependencies(streamA);
      const depsB = tracker.getDependencies(streamB);
      expect(depsA).toContain(baseStream);
      expect(depsB).toContain(baseStream);

      // Make changes in parallel streams
      const wt2 = path.join(testRepo.path, '.worktrees', agent2);
      const wt3 = path.join(testRepo.path, '.worktrees', agent3);

      tracker.createWorktree({ agentId: agent2, path: wt2, branch: `stream/${streamA}` });
      tracker.createWorktree({ agentId: agent3, path: wt3, branch: `stream/${streamB}` });

      fs.writeFileSync(path.join(wt2, 'feature-a.ts'), 'export function featureA() {}');
      execSync('git add .', { cwd: wt2, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: streamA,
        message: 'feat: implement feature A',
        agentId: agent2,
        worktree: wt2,
      });

      fs.writeFileSync(path.join(wt3, 'feature-b.ts'), 'export function featureB() {}');
      execSync('git add .', { cwd: wt3, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: streamB,
        message: 'feat: implement feature B',
        agentId: agent3,
        worktree: wt3,
      });

      // Update base stream
      fs.writeFileSync(path.join(wt1, 'base.ts'), 'export const VERSION = 2;');
      execSync('git add .', { cwd: wt1, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: baseStream,
        message: 'feat: bump version',
        agentId: agent1,
        worktree: wt1,
      });

      // Get dependents
      const dependents = tracker.getDependents(baseStream);
      expect(dependents).toContain(streamA);
      expect(dependents).toContain(streamB);

      // Sync both streams
      const resultA = tracker.syncWithParent(streamA, agent2, wt2);
      const resultB = tracker.syncWithParent(streamB, agent3, wt3);

      expect(resultA.success).toBe(true);
      expect(resultB.success).toBe(true);

      // Both should have new version
      expect(fs.readFileSync(path.join(wt2, 'base.ts'), 'utf-8')).toContain('VERSION = 2');
      expect(fs.readFileSync(path.join(wt3, 'base.ts'), 'utf-8')).toContain('VERSION = 2');

      // Stream graph should show hierarchy
      const graph = tracker.getStreamGraph(baseStream);
      expect(graph).toBeDefined();
      expect((graph as any).children.length).toBe(2);
    });

    it('should handle stream abandonment', () => {
      const agent = 'agent-abandon';
      const stream = tracker.createStream({
        name: 'risky-feature',
        agentId: agent,
      });

      const wt = path.join(testRepo.path, '.worktrees', agent);
      tracker.createWorktree({ agentId: agent, path: wt, branch: `stream/${stream}` });

      // Make a commit
      fs.writeFileSync(path.join(wt, 'feature.ts'), 'some feature');
      execSync('git add .', { cwd: wt, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: stream,
        message: 'add feature',
        agentId: agent,
        worktree: wt,
      });

      // Verify file exists
      expect(fs.existsSync(path.join(wt, 'feature.ts'))).toBe(true);

      // Abandon the stream
      tracker.abandonStream(stream, 'Decided not to pursue this feature');

      const abandoned = tracker.getStream(stream);
      expect(abandoned?.status).toBe('abandoned');
    });
  });

  describe('Agent Handoff Scenarios', () => {
    it('should support agent handoff mid-stream', () => {
      const agent1 = 'agent-original';
      const agent2 = 'agent-takeover';

      // Agent 1 starts work
      const stream = tracker.createStream({
        name: 'handoff-feature',
        agentId: agent1,
      });

      const wt1 = path.join(testRepo.path, '.worktrees', agent1);
      tracker.createWorktree({ agentId: agent1, path: wt1, branch: `stream/${stream}` });

      fs.writeFileSync(path.join(wt1, 'partial.ts'), 'partial implementation');
      execSync('git add .', { cwd: wt1, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: stream,
        message: 'wip: partial implementation',
        agentId: agent1,
        worktree: wt1,
      });

      // Agent 2 takes over - deallocate agent 1's worktree first
      tracker.deallocateWorktree(agent1);

      // Agent 2 creates their own worktree on the same branch
      const wt2 = path.join(testRepo.path, '.worktrees', agent2);
      tracker.createWorktree({ agentId: agent2, path: wt2, branch: `stream/${stream}` });

      // Agent 2 continues the work
      fs.writeFileSync(path.join(wt2, 'partial.ts'), 'complete implementation');
      execSync('git add .', { cwd: wt2, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: stream,
        message: 'feat: complete implementation',
        agentId: agent2,
        worktree: wt2,
      });

      // Both agents' commits should be in history
      const ops = tracker.getOperations({ streamId: stream });
      const agents = [...new Set(ops.map(op => op.agentId))];
      expect(agents).toContain(agent1);
      expect(agents).toContain(agent2);

      // Changes tracked correctly
      const changes = tracker.getChangesForStream(stream);
      expect(changes.length).toBe(2);
    });
  });

  describe('Complex Dependency Chains', () => {
    it('should handle linear chain A → B → C with cascading updates', () => {
      const agent = 'agent-chain';

      // Create chain: A → B → C
      const streamA = tracker.createStream({ name: 'stream-a', agentId: agent });
      const wtA = path.join(testRepo.path, '.worktrees', 'wt-a');
      tracker.createWorktree({ agentId: 'wt-a', path: wtA, branch: `stream/${streamA}` });

      fs.writeFileSync(path.join(wtA, 'a.ts'), 'v1');
      execSync('git add .', { cwd: wtA, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: streamA,
        message: 'a: v1',
        agentId: agent,
        worktree: wtA,
      });

      const streamB = tracker.forkStream({ parentStreamId: streamA, name: 'stream-b', agentId: agent });
      const wtB = path.join(testRepo.path, '.worktrees', 'wt-b');
      tracker.createWorktree({ agentId: 'wt-b', path: wtB, branch: `stream/${streamB}` });

      fs.writeFileSync(path.join(wtB, 'b.ts'), 'v1');
      execSync('git add .', { cwd: wtB, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: streamB,
        message: 'b: v1',
        agentId: agent,
        worktree: wtB,
      });

      const streamC = tracker.forkStream({ parentStreamId: streamB, name: 'stream-c', agentId: agent });
      const wtC = path.join(testRepo.path, '.worktrees', 'wt-c');
      tracker.createWorktree({ agentId: 'wt-c', path: wtC, branch: `stream/${streamC}` });

      fs.writeFileSync(path.join(wtC, 'c.ts'), 'v1');
      execSync('git add .', { cwd: wtC, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: streamC,
        message: 'c: v1',
        agentId: agent,
        worktree: wtC,
      });

      // Update A - should cascade to B and C
      fs.writeFileSync(path.join(wtA, 'a.ts'), 'v2');
      execSync('git add .', { cwd: wtA, stdio: 'pipe' });
      tracker.commitChanges({
        streamId: streamA,
        message: 'a: v2',
        agentId: agent,
        worktree: wtA,
      });

      // Manually sync B first (cascade would do this automatically)
      const resultB = tracker.syncWithParent(streamB, agent, wtB);
      expect(resultB.success).toBe(true);
      expect(fs.readFileSync(path.join(wtB, 'a.ts'), 'utf-8')).toBe('v2');

      // Now sync C
      const resultC = tracker.syncWithParent(streamC, agent, wtC);
      expect(resultC.success).toBe(true);
      expect(fs.readFileSync(path.join(wtC, 'a.ts'), 'utf-8')).toBe('v2');

      // All streams should have updated content
      expect(fs.existsSync(path.join(wtC, 'a.ts'))).toBe(true);
      expect(fs.existsSync(path.join(wtC, 'b.ts'))).toBe(true);
      expect(fs.existsSync(path.join(wtC, 'c.ts'))).toBe(true);
    });
  });
});
