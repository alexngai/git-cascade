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
import { CyclicDependencyError } from './errors.js';
import type { DependencyType } from './models/index.js';

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
 * @throws CyclicDependencyError if adding would create a cycle
 */
export function addDependency(
  db: Database.Database,
  streamId: string,
  dependsOnId: string,
  dependencyType: DependencyType = 'rebase_onto'
): void {
  // Validate both streams exist
  getStreamOrThrow(db, streamId);
  getStreamOrThrow(db, dependsOnId);

  // Check for cycles
  if (wouldCreateCycle(db, streamId, dependsOnId)) {
    throw new CyclicDependencyError(
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
    VALUES (?, ?, ?)
    ON CONFLICT (stream_id) DO UPDATE SET depends_on = ?, dependency_type = ?
  `).run(streamId, JSON.stringify(deps), dependencyType, JSON.stringify(deps), dependencyType);
}

/**
 * Add a fork dependency (called automatically by forkStream).
 */
export function addForkDependency(
  db: Database.Database,
  childStreamId: string,
  parentStreamId: string
): void {
  addDependency(db, childStreamId, parentStreamId, 'fork');
}

/**
 * Add a merge dependency (for streams that merge multiple parents).
 */
export function addMergeDependency(
  db: Database.Database,
  targetStreamId: string,
  sourceStreamIds: string[]
): void {
  // Validate all streams exist
  getStreamOrThrow(db, targetStreamId);
  for (const sourceId of sourceStreamIds) {
    getStreamOrThrow(db, sourceId);
  }

  // Check for cycles with each source
  for (const sourceId of sourceStreamIds) {
    if (wouldCreateCycle(db, targetStreamId, sourceId)) {
      throw new CyclicDependencyError(
        `Cannot add merge dependency: ${targetStreamId} → ${sourceId} would create a cycle`
      );
    }
  }

  const t = getTables(db);

  // Upsert with all sources as dependencies
  db.prepare(`
    INSERT INTO ${t.dependencies} (stream_id, depends_on, dependency_type)
    VALUES (?, ?, 'merge')
    ON CONFLICT (stream_id) DO UPDATE SET depends_on = ?, dependency_type = 'merge'
  `).run(targetStreamId, JSON.stringify(sourceStreamIds), JSON.stringify(sourceStreamIds));
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

// ─────────────────────────────────────────────────────────────────────────────
// Dependency Type and Graph Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the dependency type for a stream.
 */
export function getDependencyType(
  db: Database.Database,
  streamId: string
): DependencyType | null {
  const t = getTables(db);

  const row = db.prepare(`
    SELECT dependency_type FROM ${t.dependencies}
    WHERE stream_id = ?
  `).get(streamId) as { dependency_type: string } | undefined;

  return (row?.dependency_type as DependencyType) ?? null;
}

/**
 * Check if a stream has a diamond dependency (multiple parents).
 * Diamond dependencies require manual resolution during cascade rebase.
 */
export function isDiamondDependency(
  db: Database.Database,
  streamId: string
): boolean {
  const deps = getDependencies(db, streamId);
  const depType = getDependencyType(db, streamId);

  // Merge type explicitly has multiple parents
  if (depType === 'merge') {
    return true;
  }

  // Or if there are multiple dependencies regardless of type
  return deps.length > 1;
}

/**
 * Sort streams topologically so dependencies come before dependents.
 * Uses Kahn's algorithm.
 *
 * @param streamIds - Streams to sort (must be a subset of all streams)
 * @returns Sorted stream IDs (dependencies first)
 * @throws CyclicDependencyError if graph has cycles
 */
export function topologicalSort(
  db: Database.Database,
  streamIds: string[]
): string[] {
  if (streamIds.length === 0) {
    return [];
  }

  const streamSet = new Set(streamIds);

  // Build in-degree map (count of dependencies within the set)
  const inDegree: Record<string, number> = {};
  const graph: Record<string, string[]> = {};

  for (const sid of streamIds) {
    inDegree[sid] = 0;
    graph[sid] = [];
  }

  // Build the graph: for each stream, find its dependencies within the set
  for (const sid of streamIds) {
    const streamDeps = getDependencies(db, sid);
    for (const dep of streamDeps) {
      // Only count dependencies that are in our set
      if (streamSet.has(dep) && graph[dep] !== undefined && inDegree[sid] !== undefined) {
        graph[dep].push(sid); // dep -> sid edge (dep must come before sid)
        inDegree[sid]++;
      }
    }
  }

  // Kahn's algorithm
  const queue = streamIds.filter((s) => inDegree[s] === 0);
  const result: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    const children = graph[current] ?? [];
    for (const child of children) {
      if (inDegree[child] !== undefined) {
        inDegree[child]--;
        if (inDegree[child] === 0) {
          queue.push(child);
        }
      }
    }
  }

  // Check for cycles
  if (result.length !== streamIds.length) {
    const remaining = streamIds.filter((s) => !result.includes(s));
    throw new CyclicDependencyError(
      `Dependency graph has cycles involving: ${remaining.join(', ')}`
    );
  }

  return result;
}
