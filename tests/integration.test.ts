/**
 * Integration tests for existing database and table prefix features.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import Database from 'better-sqlite3';
import { MultiAgentRepoTracker } from '../src/index.js';
import { createTestRepo, type TestRepo } from './setup.js';

describe('Existing Database Integration', () => {
  let testRepo: TestRepo;
  let existingDb: Database.Database;

  beforeEach(() => {
    testRepo = createTestRepo();
    // Create an existing database
    existingDb = new Database(':memory:');
    // Add some dummy data to prove it's our database
    existingDb.exec('CREATE TABLE my_app_data (id INTEGER PRIMARY KEY, value TEXT)');
    existingDb.exec("INSERT INTO my_app_data (value) VALUES ('test-data')");
  });

  afterEach(() => {
    existingDb.close();
    testRepo.cleanup();
  });

  it('should use existing database without prefix', () => {
    const tracker = new MultiAgentRepoTracker({
      repoPath: testRepo.path,
      db: existingDb,
    });

    // Create a stream
    const streamId = tracker.createStream({
      name: 'test-stream',
      agentId: 'agent-1',
    });

    // Verify the stream exists
    const stream = tracker.getStream(streamId);
    expect(stream).not.toBeNull();
    expect(stream!.name).toBe('test-stream');

    // Verify our original table still exists
    const row = existingDb
      .prepare('SELECT * FROM my_app_data WHERE id = 1')
      .get() as { value: string };
    expect(row.value).toBe('test-data');

    // Verify git-cascade tables were created without prefix
    const tables = existingDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain('streams');
    expect(tableNames).toContain('operations');
    expect(tableNames).toContain('agent_worktrees');
    expect(tableNames).toContain('my_app_data');

    // Don't close the tracker (it doesn't own the DB)
    tracker.close();

    // Verify DB is still usable
    const row2 = existingDb
      .prepare('SELECT * FROM my_app_data WHERE id = 1')
      .get() as { value: string };
    expect(row2.value).toBe('test-data');
  });

  it('should use existing database with table prefix', () => {
    const tracker = new MultiAgentRepoTracker({
      repoPath: testRepo.path,
      db: existingDb,
      tablePrefix: 'gc_',
    });

    // Create a stream
    const streamId = tracker.createStream({
      name: 'prefixed-stream',
      agentId: 'agent-1',
    });

    // Verify the stream exists
    const stream = tracker.getStream(streamId);
    expect(stream).not.toBeNull();
    expect(stream!.name).toBe('prefixed-stream');

    // Verify git-cascade tables were created WITH prefix
    const tables = existingDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain('gc_streams');
    expect(tableNames).toContain('gc_operations');
    expect(tableNames).toContain('gc_agent_worktrees');
    expect(tableNames).toContain('my_app_data');

    // Should NOT have unprefixed tables
    expect(tableNames).not.toContain('streams');

    tracker.close();
  });

  it('should allow sharing same DB connection with same prefix', () => {
    // When using the same database connection, all trackers share the same prefix
    const tracker1 = new MultiAgentRepoTracker({
      repoPath: testRepo.path,
      db: existingDb,
      tablePrefix: 'shared_',
    });

    const tracker2 = new MultiAgentRepoTracker({
      repoPath: testRepo.path,
      db: existingDb,
      tablePrefix: 'shared_', // Same prefix
    });

    // Create streams in each tracker
    const stream1 = tracker1.createStream({
      name: 'stream-1',
      agentId: 'agent-1',
    });

    const stream2 = tracker2.createStream({
      name: 'stream-2',
      agentId: 'agent-2',
    });

    // Both trackers see both streams (they share the same tables)
    expect(tracker1.getStream(stream1)).not.toBeNull();
    expect(tracker1.getStream(stream2)).not.toBeNull();

    expect(tracker2.getStream(stream1)).not.toBeNull();
    expect(tracker2.getStream(stream2)).not.toBeNull();

    // List all streams
    const streams1 = tracker1.listStreams();
    const streams2 = tracker2.listStreams();
    expect(streams1.length).toBe(2);
    expect(streams2.length).toBe(2);

    tracker1.close();
    tracker2.close();
  });

  it('should work with all CRUD operations', () => {
    const tracker = new MultiAgentRepoTracker({
      repoPath: testRepo.path,
      db: existingDb,
      tablePrefix: 'dp_',
    });

    // Test stream operations
    const streamId = tracker.createStream({
      name: 'test-stream',
      agentId: 'agent-1',
    });

    const stream = tracker.getStream(streamId);
    expect(stream).not.toBeNull();

    // Test operations logging
    const opId = tracker.recordOperation({
      streamId,
      agentId: 'agent-1',
      opType: 'commit',
      beforeState: 'abc',
      afterState: 'def',
    });

    const op = tracker.getOperation(opId);
    expect(op).not.toBeNull();
    expect(op!.streamId).toBe(streamId);

    // Test worktree management
    const wtPath = path.join(testRepo.path, '.worktrees', 'agent-1');
    const worktree = tracker.createWorktree({
      agentId: 'agent-1',
      path: wtPath,
      branch: `stream/${streamId}`,
    });

    expect(worktree.agentId).toBe('agent-1');
    expect(worktree.currentStream).toBe(streamId);

    // Cleanup worktree
    tracker.deallocateWorktree('agent-1');

    tracker.close();
  });
});
