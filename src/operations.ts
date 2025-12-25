/**
 * Operation logging for audit trail and rollback.
 */

import type Database from 'better-sqlite3';
import * as crypto from 'crypto';
import { getTables } from './db/tables.js';
import type {
  Operation,
  OperationType,
  RecordOperationOptions,
} from './models/index.js';

/**
 * Generate a unique operation ID.
 */
function generateOperationId(): string {
  return `op-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Convert database row to Operation object.
 */
function rowToOperation(row: Record<string, unknown>): Operation {
  return {
    id: row.id as string,
    streamId: row.stream_id as string,
    agentId: row.agent_id as string,
    opType: row.op_type as OperationType,
    beforeState: row.before_state as string,
    afterState: row.after_state as string,
    parentOps: JSON.parse((row.parent_ops as string) || '[]'),
    timestamp: row.timestamp as number,
    metadata: JSON.parse((row.metadata as string) || '{}'),
  };
}

/**
 * Record a new operation.
 */
export function recordOperation(
  db: Database.Database,
  options: RecordOperationOptions
): string {
  const operationId = generateOperationId();
  const t = getTables(db);
  const now = Date.now();

  db.prepare(`
    INSERT INTO ${t.operations} (
      id, stream_id, agent_id, op_type, before_state, after_state,
      parent_ops, timestamp, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    operationId,
    options.streamId,
    options.agentId,
    options.opType,
    options.beforeState,
    options.afterState,
    JSON.stringify(options.parentOps ?? []),
    now,
    JSON.stringify(options.metadata ?? {})
  );

  return operationId;
}

/**
 * Get an operation by ID.
 */
export function getOperation(
  db: Database.Database,
  operationId: string
): Operation | null {
  const t = getTables(db);
  const row = db
    .prepare(`SELECT * FROM ${t.operations} WHERE id = ?`)
    .get(operationId) as Record<string, unknown> | undefined;

  return row ? rowToOperation(row) : null;
}

/**
 * List operations with optional filters.
 */
export function getOperations(
  db: Database.Database,
  options?: {
    streamId?: string;
    agentId?: string;
    opType?: OperationType;
    since?: number;
  }
): Operation[] {
  const t = getTables(db);
  let query = `SELECT * FROM ${t.operations} WHERE 1=1`;
  const params: unknown[] = [];

  if (options?.streamId) {
    query += ' AND stream_id = ?';
    params.push(options.streamId);
  }
  if (options?.agentId) {
    query += ' AND agent_id = ?';
    params.push(options.agentId);
  }
  if (options?.opType) {
    query += ' AND op_type = ?';
    params.push(options.opType);
  }
  if (options?.since) {
    query += ' AND timestamp >= ?';
    params.push(options.since);
  }

  query += ' ORDER BY timestamp ASC';

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(rowToOperation);
}

/**
 * Get the latest operation for a stream.
 */
export function getLatestOperation(
  db: Database.Database,
  streamId: string
): Operation | null {
  const t = getTables(db);
  const row = db
    .prepare(
      `SELECT * FROM ${t.operations} WHERE stream_id = ? ORDER BY timestamp DESC LIMIT 1`
    )
    .get(streamId) as Record<string, unknown> | undefined;

  return row ? rowToOperation(row) : null;
}

/**
 * Get the chain of operations leading to a specific operation.
 * Returns operations from oldest to newest.
 */
export function getOperationChain(
  db: Database.Database,
  operationId: string
): Operation[] {
  const chain: Operation[] = [];
  const visited = new Set<string>();

  function walkParents(opId: string): void {
    if (visited.has(opId)) return;
    visited.add(opId);

    const op = getOperation(db, opId);
    if (!op) return;

    // Walk parents first (older operations)
    for (const parentId of op.parentOps) {
      walkParents(parentId);
    }

    chain.push(op);
  }

  walkParents(operationId);
  return chain;
}

/**
 * Get operation count for a stream.
 */
export function getOperationCount(
  db: Database.Database,
  streamId: string
): number {
  const t = getTables(db);
  const row = db
    .prepare(`SELECT COUNT(*) as count FROM ${t.operations} WHERE stream_id = ?`)
    .get(streamId) as { count: number };

  return row.count;
}
