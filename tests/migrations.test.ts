/**
 * Dataplane migration system tests.
 *
 * Tests for the versioned migration system.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  runDataplaneMigrations,
  getCurrentDataplaneMigrationVersion,
  getDataplaneMigrations,
  getLatestDataplaneMigrationVersion,
  rollbackDataplaneMigration,
} from '../src/db/migrations.js';

describe('Dataplane Migrations', () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    // Create a temporary database
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataplane-migration-test-'));
    dbPath = path.join(tempDir, 'test.db');
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
    // Clean up temp files
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
    const tempDir = path.dirname(dbPath);
    if (fs.existsSync(tempDir)) {
      fs.rmdirSync(tempDir, { recursive: true });
    }
  });

  describe('getCurrentDataplaneMigrationVersion', () => {
    it('should return 0 for a fresh database', () => {
      const version = getCurrentDataplaneMigrationVersion(db);
      expect(version).toBe(0);
    });

    it('should create the migrations table if it does not exist', () => {
      getCurrentDataplaneMigrationVersion(db);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dataplane_migrations'")
        .all() as Array<{ name: string }>;

      expect(tables.length).toBe(1);
    });

    it('should support table prefixes', () => {
      const version = getCurrentDataplaneMigrationVersion(db, 'dp_');
      expect(version).toBe(0);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dp_dataplane_migrations'")
        .all() as Array<{ name: string }>;

      expect(tables.length).toBe(1);
    });
  });

  describe('getDataplaneMigrations', () => {
    it('should return all available migrations', () => {
      const migrations = getDataplaneMigrations();
      expect(migrations.length).toBeGreaterThanOrEqual(2);
      expect(migrations[0].version).toBe(1);
      expect(migrations[0].name).toBe('add-branch-point-commit');
      expect(migrations[1].version).toBe(2);
      expect(migrations[1].name).toBe('add-stream-merges-table');
    });

    it('should return migrations in order', () => {
      const migrations = getDataplaneMigrations();
      for (let i = 1; i < migrations.length; i++) {
        expect(migrations[i].version).toBeGreaterThan(migrations[i - 1].version);
      }
    });
  });

  describe('getLatestDataplaneMigrationVersion', () => {
    it('should return the highest version number', () => {
      const migrations = getDataplaneMigrations();
      const latest = getLatestDataplaneMigrationVersion();
      expect(latest).toBe(Math.max(...migrations.map((m) => m.version)));
    });
  });

  describe('runDataplaneMigrations', () => {
    beforeEach(() => {
      // Create the base streams table that migrations depend on
      db.exec(`
        CREATE TABLE streams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          parent_stream TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          merged_into TEXT,
          enable_stacked_review INTEGER NOT NULL DEFAULT 0,
          metadata TEXT NOT NULL DEFAULT '{}',
          existing_branch TEXT,
          is_local_mode INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (parent_stream) REFERENCES streams(id)
        );
      `);
    });

    it('should run all pending migrations on a fresh database', () => {
      const applied = runDataplaneMigrations(db);
      expect(applied).toBeGreaterThanOrEqual(2);

      const version = getCurrentDataplaneMigrationVersion(db);
      expect(version).toBe(getLatestDataplaneMigrationVersion());
    });

    it('should add branch_point_commit column via migration 1', () => {
      runDataplaneMigrations(db);

      const columns = db.pragma('table_info(streams)') as Array<{ name: string }>;
      const hasBranchPointCommit = columns.some((col) => col.name === 'branch_point_commit');
      expect(hasBranchPointCommit).toBe(true);
    });

    it('should create stream_merges table via migration 2', () => {
      runDataplaneMigrations(db);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stream_merges'")
        .all() as Array<{ name: string }>;

      expect(tables.length).toBe(1);
    });

    it('should create indexes for stream_merges table', () => {
      runDataplaneMigrations(db);

      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%stream_merges%'")
        .all() as Array<{ name: string }>;

      expect(indexes.length).toBeGreaterThanOrEqual(2);
    });

    it('should be idempotent', () => {
      // Run migrations twice
      const first = runDataplaneMigrations(db);
      const second = runDataplaneMigrations(db);

      expect(first).toBeGreaterThanOrEqual(2);
      expect(second).toBe(0); // No new migrations
    });

    it('should work with table prefix', () => {
      // Create prefixed streams table
      db.exec(`
        CREATE TABLE dp_streams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          parent_stream TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          merged_into TEXT,
          enable_stacked_review INTEGER NOT NULL DEFAULT 0,
          metadata TEXT NOT NULL DEFAULT '{}',
          existing_branch TEXT,
          is_local_mode INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (parent_stream) REFERENCES dp_streams(id)
        );
      `);

      const applied = runDataplaneMigrations(db, 'dp_');
      expect(applied).toBeGreaterThanOrEqual(2);

      // Check prefixed tables and columns
      const columns = db.pragma('table_info(dp_streams)') as Array<{ name: string }>;
      const hasBranchPointCommit = columns.some((col) => col.name === 'branch_point_commit');
      expect(hasBranchPointCommit).toBe(true);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dp_stream_merges'")
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(1);

      // Check version is tracked in prefixed table
      const version = getCurrentDataplaneMigrationVersion(db, 'dp_');
      expect(version).toBe(getLatestDataplaneMigrationVersion());
    });

    it('should record each migration in the migrations table', () => {
      runDataplaneMigrations(db);

      const migrations = db
        .prepare('SELECT * FROM dataplane_migrations ORDER BY version')
        .all() as Array<{ version: number; name: string; applied_at: number }>;

      expect(migrations.length).toBeGreaterThanOrEqual(2);
      expect(migrations[0].version).toBe(1);
      expect(migrations[0].name).toBe('add-branch-point-commit');
      expect(migrations[1].version).toBe(2);
      expect(migrations[1].name).toBe('add-stream-merges-table');

      // Check that applied_at is a valid timestamp
      for (const m of migrations) {
        expect(m.applied_at).toBeGreaterThan(0);
      }
    });

    it('should skip migrations that have already been applied', () => {
      // Manually record migration 1 as applied
      getCurrentDataplaneMigrationVersion(db); // Creates table
      db.prepare('INSERT INTO dataplane_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(1, 'add-branch-point-commit', Date.now());

      const applied = runDataplaneMigrations(db);

      // Should only apply migration 2+
      expect(applied).toBe(getLatestDataplaneMigrationVersion() - 1);

      // Verify migration 2 was applied
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stream_merges'")
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(1);
    });
  });

  describe('rollbackDataplaneMigration', () => {
    beforeEach(() => {
      // Create base streams table
      db.exec(`
        CREATE TABLE streams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          parent_stream TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          merged_into TEXT,
          enable_stacked_review INTEGER NOT NULL DEFAULT 0,
          metadata TEXT NOT NULL DEFAULT '{}',
          existing_branch TEXT,
          is_local_mode INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (parent_stream) REFERENCES streams(id)
        );
      `);
    });

    it('should return false when no migrations to rollback', () => {
      const result = rollbackDataplaneMigration(db);
      expect(result).toBe(false);
    });

    it('should rollback the last migration', () => {
      // Apply all migrations
      runDataplaneMigrations(db);
      const versionBefore = getCurrentDataplaneMigrationVersion(db);

      // Rollback
      const result = rollbackDataplaneMigration(db);
      expect(result).toBe(true);

      const versionAfter = getCurrentDataplaneMigrationVersion(db);
      expect(versionAfter).toBe(versionBefore - 1);
    });

    it('should remove stream_merges table when rolling back migration 2', () => {
      runDataplaneMigrations(db);

      // Verify table exists
      let tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stream_merges'")
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(1);

      // Rollback all migrations after migration 2 first
      const latestVersion = getLatestDataplaneMigrationVersion();
      for (let i = latestVersion; i > 2; i--) {
        rollbackDataplaneMigration(db);
      }

      // Now rollback migration 2
      rollbackDataplaneMigration(db);

      // Verify table is dropped
      tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stream_merges'")
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(0);
    });
  });

  describe('migration 1: add-branch-point-commit', () => {
    it('should not fail if column already exists', () => {
      // Create streams table with branch_point_commit already
      db.exec(`
        CREATE TABLE streams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          parent_stream TEXT,
          branch_point_commit TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          merged_into TEXT,
          enable_stacked_review INTEGER NOT NULL DEFAULT 0,
          metadata TEXT NOT NULL DEFAULT '{}',
          existing_branch TEXT,
          is_local_mode INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (parent_stream) REFERENCES streams(id)
        );
      `);

      // Migration should be idempotent
      expect(() => runDataplaneMigrations(db)).not.toThrow();
    });

    it('should not fail if streams table does not exist', () => {
      // Don't create streams table
      expect(() => runDataplaneMigrations(db)).not.toThrow();
    });
  });

  describe('migration 2: add-stream-merges-table', () => {
    beforeEach(() => {
      db.exec(`
        CREATE TABLE streams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          parent_stream TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          merged_into TEXT,
          enable_stacked_review INTEGER NOT NULL DEFAULT 0,
          metadata TEXT NOT NULL DEFAULT '{}',
          existing_branch TEXT,
          is_local_mode INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (parent_stream) REFERENCES streams(id)
        );
      `);
    });

    it('should not fail if stream_merges table already exists', () => {
      // Create stream_merges table manually
      db.exec(`
        CREATE TABLE stream_merges (
          id TEXT PRIMARY KEY,
          source_stream_id TEXT NOT NULL,
          source_commit TEXT NOT NULL,
          target_stream_id TEXT NOT NULL,
          merge_commit TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}'
        );
      `);

      // Migration should be idempotent
      expect(() => runDataplaneMigrations(db)).not.toThrow();
    });

    it('should create correct schema for stream_merges', () => {
      runDataplaneMigrations(db);

      const columns = db.pragma('table_info(stream_merges)') as Array<{ name: string; type: string; notnull: number }>;
      const columnMap = new Map(columns.map((c) => [c.name, c]));

      expect(columnMap.has('id')).toBe(true);
      expect(columnMap.has('source_stream_id')).toBe(true);
      expect(columnMap.has('source_commit')).toBe(true);
      expect(columnMap.has('target_stream_id')).toBe(true);
      expect(columnMap.has('merge_commit')).toBe(true);
      expect(columnMap.has('created_at')).toBe(true);
      expect(columnMap.has('metadata')).toBe(true);

      // Check NOT NULL constraints
      expect(columnMap.get('source_stream_id')?.notnull).toBe(1);
      expect(columnMap.get('target_stream_id')?.notnull).toBe(1);
    });
  });

  describe('migration 3: add-checkpoints-and-diff-stacks', () => {
    beforeEach(() => {
      db.exec(`
        CREATE TABLE streams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          parent_stream TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          merged_into TEXT,
          enable_stacked_review INTEGER NOT NULL DEFAULT 0,
          metadata TEXT NOT NULL DEFAULT '{}',
          existing_branch TEXT,
          is_local_mode INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (parent_stream) REFERENCES streams(id)
        );
      `);
    });

    it('should create checkpoints table with correct schema', () => {
      runDataplaneMigrations(db);

      const columns = db.pragma('table_info(checkpoints)') as Array<{ name: string; type: string; notnull: number }>;
      const columnMap = new Map(columns.map((c) => [c.name, c]));

      expect(columnMap.has('id')).toBe(true);
      expect(columnMap.has('stream_id')).toBe(true);
      expect(columnMap.has('commit_sha')).toBe(true);
      expect(columnMap.has('parent_commit')).toBe(true);
      expect(columnMap.has('original_commit')).toBe(true);
      expect(columnMap.has('change_id')).toBe(true);
      expect(columnMap.has('message')).toBe(true);
      expect(columnMap.has('created_at')).toBe(true);
      expect(columnMap.has('created_by')).toBe(true);

      // Check NOT NULL constraints
      expect(columnMap.get('stream_id')?.notnull).toBe(1);
      expect(columnMap.get('commit_sha')?.notnull).toBe(1);
      expect(columnMap.get('created_at')?.notnull).toBe(1);
    });

    it('should create diff_stacks table with correct schema', () => {
      runDataplaneMigrations(db);

      const columns = db.pragma('table_info(diff_stacks)') as Array<{ name: string; type: string; notnull: number }>;
      const columnMap = new Map(columns.map((c) => [c.name, c]));

      expect(columnMap.has('id')).toBe(true);
      expect(columnMap.has('name')).toBe(true);
      expect(columnMap.has('description')).toBe(true);
      expect(columnMap.has('target_branch')).toBe(true);
      expect(columnMap.has('review_status')).toBe(true);
      expect(columnMap.has('reviewed_by')).toBe(true);
      expect(columnMap.has('reviewed_at')).toBe(true);
      expect(columnMap.has('review_notes')).toBe(true);
      expect(columnMap.has('queue_position')).toBe(true);
      expect(columnMap.has('created_at')).toBe(true);
      expect(columnMap.has('created_by')).toBe(true);

      // Check NOT NULL constraints
      expect(columnMap.get('target_branch')?.notnull).toBe(1);
      expect(columnMap.get('review_status')?.notnull).toBe(1);
      expect(columnMap.get('created_at')?.notnull).toBe(1);
    });

    it('should create diff_stack_entries table with correct schema', () => {
      runDataplaneMigrations(db);

      const columns = db.pragma('table_info(diff_stack_entries)') as Array<{ name: string; type: string; notnull: number }>;
      const columnMap = new Map(columns.map((c) => [c.name, c]));

      expect(columnMap.has('id')).toBe(true);
      expect(columnMap.has('stack_id')).toBe(true);
      expect(columnMap.has('checkpoint_id')).toBe(true);
      expect(columnMap.has('position')).toBe(true);

      // Check NOT NULL constraints
      expect(columnMap.get('stack_id')?.notnull).toBe(1);
      expect(columnMap.get('checkpoint_id')?.notnull).toBe(1);
      expect(columnMap.get('position')?.notnull).toBe(1);
    });

    it('should create indexes for checkpoints table', () => {
      runDataplaneMigrations(db);

      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='checkpoints'")
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);

      expect(indexNames).toContain('idx_checkpoints_stream');
      expect(indexNames).toContain('idx_checkpoints_change_id');
    });

    it('should create indexes for diff_stacks table', () => {
      runDataplaneMigrations(db);

      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='diff_stacks'")
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);

      expect(indexNames).toContain('idx_diff_stacks_status');
      expect(indexNames).toContain('idx_diff_stacks_queue');
    });

    it('should create indexes for diff_stack_entries table', () => {
      runDataplaneMigrations(db);

      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='diff_stack_entries'")
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);

      expect(indexNames).toContain('idx_stack_entries_stack_id');
      expect(indexNames).toContain('idx_stack_entries_checkpoint_id');
    });

    it('should be idempotent when tables already exist', () => {
      // Create tables manually first
      db.exec(`
        CREATE TABLE checkpoints (
          id TEXT PRIMARY KEY,
          stream_id TEXT NOT NULL,
          commit_sha TEXT NOT NULL,
          parent_commit TEXT,
          original_commit TEXT,
          change_id TEXT,
          message TEXT,
          created_at INTEGER NOT NULL,
          created_by TEXT,
          UNIQUE(stream_id, commit_sha)
        );
        CREATE TABLE diff_stacks (
          id TEXT PRIMARY KEY,
          name TEXT,
          description TEXT,
          target_branch TEXT NOT NULL DEFAULT 'main',
          review_status TEXT NOT NULL DEFAULT 'pending',
          reviewed_by TEXT,
          reviewed_at INTEGER,
          review_notes TEXT,
          queue_position INTEGER,
          created_at INTEGER NOT NULL,
          created_by TEXT
        );
        CREATE TABLE diff_stack_entries (
          id TEXT PRIMARY KEY,
          stack_id TEXT NOT NULL,
          checkpoint_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          UNIQUE(stack_id, checkpoint_id)
        );
      `);

      // Migration should be idempotent - should not throw
      expect(() => runDataplaneMigrations(db)).not.toThrow();
    });

    it('should enforce unique constraint on checkpoints (stream_id, commit_sha)', () => {
      runDataplaneMigrations(db);

      // Insert a stream first
      db.exec(`
        INSERT INTO streams (id, name, agent_id, base_commit, created_at, updated_at)
        VALUES ('stream-1', 'test', 'agent-1', 'abc123', ${Date.now()}, ${Date.now()})
      `);

      // Insert first checkpoint
      db.exec(`
        INSERT INTO checkpoints (id, stream_id, commit_sha, created_at)
        VALUES ('cp-1', 'stream-1', 'commit-abc', ${Date.now()})
      `);

      // Try to insert duplicate - should fail
      expect(() => {
        db.exec(`
          INSERT INTO checkpoints (id, stream_id, commit_sha, created_at)
          VALUES ('cp-2', 'stream-1', 'commit-abc', ${Date.now()})
        `);
      }).toThrow();
    });

    it('should enforce unique constraint on diff_stack_entries (stack_id, checkpoint_id)', () => {
      runDataplaneMigrations(db);

      // Insert prerequisite data
      db.exec(`
        INSERT INTO streams (id, name, agent_id, base_commit, created_at, updated_at)
        VALUES ('stream-1', 'test', 'agent-1', 'abc123', ${Date.now()}, ${Date.now()})
      `);
      db.exec(`
        INSERT INTO checkpoints (id, stream_id, commit_sha, created_at)
        VALUES ('cp-1', 'stream-1', 'commit-abc', ${Date.now()})
      `);
      db.exec(`
        INSERT INTO diff_stacks (id, target_branch, review_status, created_at)
        VALUES ('ds-1', 'main', 'pending', ${Date.now()})
      `);

      // Insert first entry
      db.exec(`
        INSERT INTO diff_stack_entries (id, stack_id, checkpoint_id, position)
        VALUES ('entry-1', 'ds-1', 'cp-1', 0)
      `);

      // Try to insert duplicate - should fail
      expect(() => {
        db.exec(`
          INSERT INTO diff_stack_entries (id, stack_id, checkpoint_id, position)
          VALUES ('entry-2', 'ds-1', 'cp-1', 1)
        `);
      }).toThrow();
    });

    it('should rollback and remove all three tables', () => {
      runDataplaneMigrations(db);

      // Verify tables exist
      let tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('checkpoints', 'diff_stacks', 'diff_stack_entries')")
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(3);

      // Rollback migration 4 (worker_tasks) first, then migration 3
      rollbackDataplaneMigration(db); // Rolls back migration 4
      rollbackDataplaneMigration(db); // Rolls back migration 3

      // Verify tables are dropped
      tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('checkpoints', 'diff_stacks', 'diff_stack_entries')")
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(0);
    });
  });
});
