/**
 * Table name utilities with prefix support.
 */

import type Database from 'better-sqlite3';

export interface TableNames {
  streams: string;
  operations: string;
  review_blocks: string;
  stack_entries: string;
  stack_configs: string;
  agent_worktrees: string;
  stream_locks: string;
  stream_guards: string;
  changes: string;
  dependencies: string;
  conflicts: string;
  wc_snapshots: string;
  archived_streams: string;
  gc_config: string;
  operation_checkpoints: string;
  merge_queue: string;
  stream_merges: string;
}

/**
 * Registry to associate Database instances with their table names.
 */
const tableRegistry = new WeakMap<Database.Database, TableNames>();

/**
 * Get all table names with the specified prefix.
 */
export function getTableNames(prefix: string = ''): TableNames {
  return {
    streams: `${prefix}streams`,
    operations: `${prefix}operations`,
    review_blocks: `${prefix}review_blocks`,
    stack_entries: `${prefix}stack_entries`,
    stack_configs: `${prefix}stack_configs`,
    agent_worktrees: `${prefix}agent_worktrees`,
    stream_locks: `${prefix}stream_locks`,
    stream_guards: `${prefix}stream_guards`,
    changes: `${prefix}changes`,
    dependencies: `${prefix}dependencies`,
    conflicts: `${prefix}conflicts`,
    wc_snapshots: `${prefix}wc_snapshots`,
    archived_streams: `${prefix}archived_streams`,
    gc_config: `${prefix}gc_config`,
    operation_checkpoints: `${prefix}operation_checkpoints`,
    merge_queue: `${prefix}merge_queue`,
    stream_merges: `${prefix}stream_merges`,
  };
}

/**
 * Register table names for a database instance.
 */
export function registerTables(db: Database.Database, tables: TableNames): void {
  tableRegistry.set(db, tables);
}

/**
 * Get table names for a database instance.
 * Returns default (unprefixed) names if not registered.
 */
export function getTables(db: Database.Database): TableNames {
  return tableRegistry.get(db) ?? getTableNames('');
}
