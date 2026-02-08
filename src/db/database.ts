/**
 * Database layer using better-sqlite3 with WAL mode.
 *
 * Provides concurrent read/write access for multi-agent coordination.
 */

import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';

export interface DatabaseOptions {
  /** Path to SQLite database file (ignored if db is provided) */
  path?: string;
  /** Existing database connection (optional) */
  db?: Database.Database;
  /** Table name prefix (default: no prefix) */
  tablePrefix?: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Initialize the database with schema.
 */
export function createDatabase(options: DatabaseOptions): Database.Database {
  let db: Database.Database;

  if (options.db) {
    // Use existing database connection
    db = options.db;
  } else {
    // Create new database
    if (!options.path) {
      throw new Error('Either db or path must be provided');
    }
    db = new Database(options.path, {
      verbose: options.verbose ? console.log : undefined,
    });

    // Enable WAL mode for concurrent access (only if we created the DB)
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
  }

  // Always enable foreign keys
  db.pragma('foreign_keys = ON');

  // Create schema with optional prefix
  const prefix = options.tablePrefix ?? '';
  initializeSchema(db, prefix);

  return db;
}

/**
 * Initialize database schema.
 */
function initializeSchema(db: Database.Database, prefix: string): void {
  db.exec(`
    -- Streams table
    CREATE TABLE IF NOT EXISTS ${prefix}streams (
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
      FOREIGN KEY (parent_stream) REFERENCES ${prefix}streams(id)
    );

    -- Operations table
    CREATE TABLE IF NOT EXISTS ${prefix}operations (
      id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      op_type TEXT NOT NULL,
      before_state TEXT NOT NULL,
      after_state TEXT NOT NULL,
      parent_ops TEXT NOT NULL DEFAULT '[]',
      timestamp INTEGER NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (stream_id) REFERENCES ${prefix}streams(id)
    );

    -- Review blocks table (reviewable units containing one or more commits)
    CREATE TABLE IF NOT EXISTS ${prefix}review_blocks (
      id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      stack_name TEXT NOT NULL DEFAULT 'default',
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      review_status TEXT NOT NULL DEFAULT 'draft',
      reviewed_by TEXT,
      reviewed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (stream_id) REFERENCES ${prefix}streams(id)
    );

    -- Stack entries table (commits within review blocks)
    CREATE TABLE IF NOT EXISTS ${prefix}stack_entries (
      id TEXT PRIMARY KEY,
      review_block_id TEXT NOT NULL,
      commit_hash TEXT NOT NULL,
      commit_position INTEGER NOT NULL,
      original_commit TEXT NOT NULL,
      change_id TEXT,
      FOREIGN KEY (review_block_id) REFERENCES ${prefix}review_blocks(id) ON DELETE CASCADE
    );

    -- Stack configs table (per-stream per-stack configuration)
    CREATE TABLE IF NOT EXISTS ${prefix}stack_configs (
      stream_id TEXT NOT NULL,
      stack_name TEXT NOT NULL DEFAULT 'default',
      config_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (stream_id, stack_name),
      FOREIGN KEY (stream_id) REFERENCES ${prefix}streams(id)
    );

    -- Agent worktrees table
    CREATE TABLE IF NOT EXISTS ${prefix}agent_worktrees (
      agent_id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      current_stream TEXT,
      created_at INTEGER NOT NULL,
      last_active INTEGER NOT NULL,
      FOREIGN KEY (current_stream) REFERENCES ${prefix}streams(id)
    );

    -- Stream locks table
    CREATE TABLE IF NOT EXISTS ${prefix}stream_locks (
      stream_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      FOREIGN KEY (stream_id) REFERENCES ${prefix}streams(id)
    );

    -- Stream guards table (defensive concurrency checks)
    CREATE TABLE IF NOT EXISTS ${prefix}stream_guards (
      stream_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      last_write INTEGER NOT NULL,
      FOREIGN KEY (stream_id) REFERENCES ${prefix}streams(id)
    );

    -- Changes table (stable identity tracking)
    CREATE TABLE IF NOT EXISTS ${prefix}changes (
      id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      description TEXT NOT NULL,
      commit_history TEXT NOT NULL DEFAULT '[]',
      current_commit TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      squashed_into TEXT,
      split_from TEXT,
      FOREIGN KEY (stream_id) REFERENCES ${prefix}streams(id)
    );

    -- Dependencies table (cascade rebase)
    CREATE TABLE IF NOT EXISTS ${prefix}dependencies (
      stream_id TEXT PRIMARY KEY,
      depends_on TEXT NOT NULL DEFAULT '[]',
      dependency_type TEXT NOT NULL,
      FOREIGN KEY (stream_id) REFERENCES ${prefix}streams(id)
    );

    -- Conflicts table (deferred conflict handling)
    CREATE TABLE IF NOT EXISTS ${prefix}conflicts (
      id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      operation_id TEXT,
      conflicting_commit TEXT NOT NULL,
      target_commit TEXT NOT NULL,
      conflicted_files TEXT NOT NULL DEFAULT '[]',
      conflict_markers TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolution TEXT,
      FOREIGN KEY (stream_id) REFERENCES ${prefix}streams(id),
      FOREIGN KEY (operation_id) REFERENCES ${prefix}operations(id)
    );

    -- Working copy snapshots table
    CREATE TABLE IF NOT EXISTS ${prefix}wc_snapshots (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      stash_ref TEXT NOT NULL,
      head_at_snapshot TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- Archived streams table
    CREATE TABLE IF NOT EXISTS ${prefix}archived_streams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      parent_stream TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER NOT NULL,
      merged_into TEXT,
      enable_stacked_review INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',
      existing_branch TEXT,
      is_local_mode INTEGER NOT NULL DEFAULT 0
    );

    -- GC configuration table
    CREATE TABLE IF NOT EXISTS ${prefix}gc_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Operation checkpoints table (crash recovery)
    CREATE TABLE IF NOT EXISTS ${prefix}operation_checkpoints (
      operation_id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      op_type TEXT NOT NULL,
      step INTEGER NOT NULL,
      total_steps INTEGER NOT NULL,
      before_state TEXT NOT NULL,
      current_state TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      FOREIGN KEY (stream_id) REFERENCES ${prefix}streams(id)
    );

    -- Merge queue table
    CREATE TABLE IF NOT EXISTS ${prefix}merge_queue (
      id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      target_branch TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      status TEXT NOT NULL DEFAULT 'pending',
      added_by TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      error TEXT,
      merge_commit TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (stream_id) REFERENCES ${prefix}streams(id)
    );

    -- Stream merges table (DAG merge events)
    CREATE TABLE IF NOT EXISTS ${prefix}stream_merges (
      id TEXT PRIMARY KEY,
      source_stream_id TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      target_stream_id TEXT NOT NULL,
      merge_commit TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (source_stream_id) REFERENCES ${prefix}streams(id),
      FOREIGN KEY (target_stream_id) REFERENCES ${prefix}streams(id)
    );

    -- Worker tasks table (ephemeral branches for stream work)
    CREATE TABLE IF NOT EXISTS ${prefix}worker_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      agent_id TEXT,
      branch_name TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      start_commit TEXT,
      merge_commit TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      priority INTEGER NOT NULL DEFAULT 100,
      metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (stream_id) REFERENCES ${prefix}streams(id)
    );

    -- Task merges table (audit trail for task completions)
    CREATE TABLE IF NOT EXISTS ${prefix}task_merges (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      source_branch TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      target_stream_id TEXT NOT NULL,
      merge_commit TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (task_id) REFERENCES ${prefix}worker_tasks(id),
      FOREIGN KEY (target_stream_id) REFERENCES ${prefix}streams(id)
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS ${prefix}idx_streams_agent ON ${prefix}streams(agent_id);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_streams_status ON ${prefix}streams(status);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_streams_parent ON ${prefix}streams(parent_stream);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_operations_stream ON ${prefix}operations(stream_id);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_operations_timestamp ON ${prefix}operations(timestamp);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_review_blocks_stream ON ${prefix}review_blocks(stream_id);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_review_blocks_stack ON ${prefix}review_blocks(stream_id, stack_name);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_stack_entries_block ON ${prefix}stack_entries(review_block_id);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_stack_entries_commit ON ${prefix}stack_entries(commit_hash);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_stack_entries_original ON ${prefix}stack_entries(original_commit);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_stack_entries_change ON ${prefix}stack_entries(change_id);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_changes_stream ON ${prefix}changes(stream_id);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_changes_current_commit ON ${prefix}changes(current_commit);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_conflicts_stream ON ${prefix}conflicts(stream_id);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_conflicts_status ON ${prefix}conflicts(status);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_merge_queue_stream ON ${prefix}merge_queue(stream_id);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_merge_queue_target ON ${prefix}merge_queue(target_branch, status);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_merge_queue_priority ON ${prefix}merge_queue(target_branch, priority, added_at);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_stream_merges_source ON ${prefix}stream_merges(source_stream_id);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_stream_merges_target ON ${prefix}stream_merges(target_stream_id);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_worker_tasks_stream ON ${prefix}worker_tasks(stream_id);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_worker_tasks_status ON ${prefix}worker_tasks(status);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_worker_tasks_agent ON ${prefix}worker_tasks(agent_id);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_task_merges_task ON ${prefix}task_merges(task_id);
    CREATE INDEX IF NOT EXISTS ${prefix}idx_task_merges_target ON ${prefix}task_merges(target_stream_id);
  `);

  // Run versioned migrations for existing databases
  runMigrations(db, prefix);
}

/**
 * Close the database connection.
 */
export function closeDatabase(db: Database.Database): void {
  db.close();
}
