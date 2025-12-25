/**
 * Basic tracker tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker } from '../src/index.js';
import { createTestRepo, type TestRepo } from './setup.js';

describe('MultiAgentRepoTracker', () => {
  let testRepo: TestRepo;

  beforeEach(() => {
    testRepo = createTestRepo();
  });

  afterEach(() => {
    testRepo.cleanup();
  });

  it('should initialize with a repo path', () => {
    const tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });
    expect(tracker.repoPath).toBe(testRepo.path);
    tracker.close();
  });

  it('should create database with WAL mode', () => {
    const tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });

    // Check WAL mode is enabled
    const mode = tracker.db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');

    tracker.close();
  });

  it('should have all required tables', () => {
    const tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });

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

    tracker.close();
  });
});
