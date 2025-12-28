/**
 * Stream dependency tracking.
 *
 * Dependencies represent logical relationships between streams where
 * one stream should be rebased after another changes. This is separate
 * from the parent/child (structural) relationship.
 */

import type Database from 'better-sqlite3';
import { getTables } from './db/tables.js';
import { getStreamOrThrow } from './streams.js';

// ─────────────────────────────────────────────────────────────────────────────
// Dependency CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get dependencies for a stream.
 */
export function getDependencies(
  db: Database.Database,
  streamId: string
): string[] {
  const t = getTables(db);

  const row = db.prepare(`
    SELECT depends_on FROM ${t.dependencies}
    WHERE stream_id = ?
  `).get(streamId) as { depends_on: string } | undefined;

  if (!row) {
    return [];
  }

  return JSON.parse(row.depends_on) as string[];
}

/**
 * Get streams that depend on a given stream (reverse lookup).
 */
export function getDependents(
  db: Database.Database,
  streamId: string
): string[] {
  const t = getTables(db);

  // We need to scan all dependencies and check if they contain streamId
  const rows = db.prepare(`
    SELECT stream_id, depends_on FROM ${t.dependencies}
  `).all() as { stream_id: string; depends_on: string }[];

  const dependents: string[] = [];
  for (const row of rows) {
    const deps = JSON.parse(row.depends_on) as string[];
    if (deps.includes(streamId)) {
      dependents.push(row.stream_id);
    }
  }

  return dependents;
}

/**
 * Check if adding a dependency would create a cycle.
 *
 * Uses DFS: if we can reach streamId by following dependencies from dependsOnId,
 * then adding streamId → dependsOnId would create a cycle.
 */
export function wouldCreateCycle(
  db: Database.Database,
  streamId: string,
  dependsOnId: string
): boolean {
  // Self-dependency is a cycle
  if (streamId === dependsOnId) {
    return true;
  }

  // DFS from dependsOnId to see if we can reach streamId
  const visited = new Set<string>();
  const stack = [dependsOnId];

  while (stack.length > 0) {
    const current = stack.pop()!;

    if (current === streamId) {
      return true; // Found a cycle
    }

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    // Get dependencies of current and add to stack
    const deps = getDependencies(db, current);
    for (const dep of deps) {
      if (!visited.has(dep)) {
        stack.push(dep);
      }
    }
  }

  return false;
}

/**
 * Add a dependency between streams.
 *
 * @throws Error if adding would create a cycle
 */
export function addDependency(
  db: Database.Database,
  streamId: string,
  dependsOnId: string
): void {
  // Validate both streams exist
  getStreamOrThrow(db, streamId);
  getStreamOrThrow(db, dependsOnId);

  // Check for cycles
  if (wouldCreateCycle(db, streamId, dependsOnId)) {
    throw new Error(
      `Cannot add dependency: ${streamId} → ${dependsOnId} would create a cycle`
    );
  }

  const t = getTables(db);
  const deps = getDependencies(db, streamId);

  // Check if already exists
  if (deps.includes(dependsOnId)) {
    return; // Already a dependency
  }

  deps.push(dependsOnId);

  // Upsert the dependency record
  db.prepare(`
    INSERT INTO ${t.dependencies} (stream_id, depends_on, dependency_type)
    VALUES (?, ?, 'rebase')
    ON CONFLICT (stream_id) DO UPDATE SET depends_on = ?
  `).run(streamId, JSON.stringify(deps), JSON.stringify(deps));
}

/**
 * Remove a dependency between streams.
 */
export function removeDependency(
  db: Database.Database,
  streamId: string,
  dependsOnId: string
): void {
  const t = getTables(db);
  const deps = getDependencies(db, streamId);

  const index = deps.indexOf(dependsOnId);
  if (index === -1) {
    return; // Not a dependency
  }

  deps.splice(index, 1);

  if (deps.length === 0) {
    // Remove the row entirely
    db.prepare(`DELETE FROM ${t.dependencies} WHERE stream_id = ?`).run(streamId);
  } else {
    // Update with remaining dependencies
    db.prepare(`
      UPDATE ${t.dependencies} SET depends_on = ?
      WHERE stream_id = ?
    `).run(JSON.stringify(deps), streamId);
  }
}

/**
 * Get all dependencies recursively (transitive closure).
 */
export function getAllDependencies(
  db: Database.Database,
  streamId: string
): string[] {
  const all = new Set<string>();
  const stack = [streamId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const deps = getDependencies(db, current);

    for (const dep of deps) {
      if (!all.has(dep)) {
        all.add(dep);
        stack.push(dep);
      }
    }
  }

  return Array.from(all);
}

/**
 * Get all dependents recursively (reverse transitive closure).
 */
export function getAllDependents(
  db: Database.Database,
  streamId: string
): string[] {
  const all = new Set<string>();
  const stack = [streamId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const dependents = getDependents(db, current);

    for (const dep of dependents) {
      if (!all.has(dep)) {
        all.add(dep);
        stack.push(dep);
      }
    }
  }

  return Array.from(all);
}
