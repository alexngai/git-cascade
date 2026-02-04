# Dataplane Codebase Review

A comprehensive audit of the dataplane codebase identifying coherence issues, bugs, and testing gaps.

## Executive Summary

The dataplane library is a sophisticated coordination layer for multi-agent git workflows. While the architecture is sound and well-documented, there are several issues that should be addressed:

- **10 bugs identified** (1 critical, 5 high, 4 medium)
- **~60% test coverage gap** on the main API (tracker.ts)
- **Multiple user story coherence issues** around stream lifecycle and conflict handling
- **Performance concerns** with dependency lookups at scale

---

## 1. User Story Coherence Issues

### 1.1. Unused Stream Status: `paused`

**Location:** `src/models/stream.ts`

The `StreamStatus` type includes `paused` but it's never used:
- No `pauseStream()` function exists
- No code ever sets `status = 'paused'`
- Users seeing this in the type definition expect functionality that doesn't exist

**Recommendation:** Either implement pause/resume functionality or remove from the type.

### 1.2. Local Mode API Confusion

**Location:** `src/streams.ts:104-106`

Creating a local mode stream requires:
```typescript
createStream({
  existingBranch: 'my-branch',
  createBranch: false,  // Confusing double-negative
  ...
})
```

**Recommendation:** Add a dedicated `trackExistingBranch()` function.

### 1.3. Deprecated API Still Exposed

**Location:** `src/tracker.ts:388-392`

`getStreamGraph()` is deprecated with a comment but still publicly exported:
```typescript
/**
 * @deprecated Use getStreamHierarchy instead
 */
getStreamGraph(rootStreamId?: string): StreamNode | StreamNode[] {
  return streams.getStreamGraph(this.db, rootStreamId);
}
```

**Recommendation:** Remove or mark with `@deprecated` JSDoc that tools can detect.

### 1.4. Sync/Async Mismatch in Conflict Handling

**Location:** `src/streams.ts:687-749`

The `handleAgentConflictResolution` function is synchronous but accepts an async `conflictHandler`. It uses a busy-wait loop that blocks the event loop:

```typescript
while (!resolved && Date.now() - startTime < conflictTimeout) {
  const endTime = Date.now() + 10;
  while (Date.now() < endTime) {
    // Spin - This blocks the event loop!
  }
}
```

This is architecturally broken - Promise callbacks won't fire during the spin.

**Recommendation:** Make `rebaseOntoStream` and related functions async.

---

## 2. Identified Bugs

### 2.1. CRITICAL: Busy-Wait Never Resolves Promises

**Location:** `src/streams.ts:734-741`
**Severity:** Critical

The busy-wait loop will never successfully await the conflict handler because:
1. Node.js is single-threaded
2. Promise callbacks run on the event loop
3. The while loop blocks the event loop

**Result:** All agent-based conflict handlers will timeout even if they resolve instantly.

### 2.2. HEAD~1 Reference Failure on First Commit

**Location:** `src/tracker.ts:493`
**Severity:** High

```typescript
beforeState: git.resolveRef('HEAD~1', gitOpts),
```

If a worktree has only one commit, this will throw an error.

**Fix:** Check commit count or catch the error.

### 2.3. Missing Table Existence Check

**Location:** `src/recovery.ts:291-294`
**Severity:** Medium

The `stream_locks` table is queried but may not exist after certain migration paths.

### 2.4. O(n) Dependency Scan with JSON Parsing

**Location:** `src/dependencies.ts:42-62`
**Severity:** High (Performance)

```typescript
export function getDependents(db: Database.Database, streamId: string): string[] {
  const rows = db.prepare(`
    SELECT stream_id, depends_on FROM ${t.dependencies}
  `).all();  // Fetches ALL rows

  for (const row of rows) {
    const deps = JSON.parse(row.depends_on);  // Parses JSON for EACH row
    if (deps.includes(streamId)) { ... }
  }
}
```

With 1000 streams, this performs 1000 JSON.parse operations per call.

**Fix:** Add a reverse dependency table or use SQLite JSON functions.

### 2.5. Undifferentiated Error in mergeStream

**Location:** `src/streams.ts:542-553`
**Severity:** Medium

All errors return the same structure, making it impossible to distinguish conflict errors from other failures.

### 2.6. Missing Worktree Path Validation

**Location:** `src/worktrees.ts:126-135`
**Severity:** Medium

No check that `worktree.path` exists before attempting git operations.

### 2.7. Potential Null Reference in continueRebase

**Location:** `src/streams.ts:1109-1111`
**Severity:** High

If conflict is deleted from DB during resolution, base commit won't be updated.

### 2.8. Unused agentId Parameter

**Location:** `src/conflicts.ts:149`
**Severity:** Low

```typescript
export function startConflictResolution(
  db: Database.Database,
  conflictId: string,
  _agentId: string  // Never used
): void {
```

Loses audit trail information.

### 2.9. Inconsistent Module Import Pattern

**Location:** `src/git/commands.ts:320-321`
**Severity:** Low

```typescript
const fs = require('fs');  // Inside an ES module
```

Should use `import * as fs from 'fs'` at top level.

### 2.10. Change-Id Extraction Logic Error

**Location:** `src/git/commands.ts:690-693`
**Severity:** Medium

The comment says "Stop searching" but code says `continue`:
```typescript
if (trimmed === '' || ...) {
  continue;  // Should be break?
}
```

---

## 3. Testing Gaps

### 3.1. Main API (tracker.ts)

**Current:** 3 tests, 56 lines
**Functions:** 100+ public methods
**Coverage:** ~3%

This is the critical entry point for users and has almost no test coverage.

### 3.2. Missing Unit Tests

| Function | Module | Priority |
|----------|--------|----------|
| `mergeStream()` | streams.ts | High |
| `syncWithParent()` | streams.ts | High |
| `rebaseOntoStream()` | streams.ts | High |
| `continueRebase()` | streams.ts | High |
| `abortConflictedRebase()` | streams.ts | Medium |
| `getOperationCount()` | operations.ts | Low |
| `startConflictResolution()` | conflicts.ts | Medium |
| `buildPatchIdMap()` | git/commands.ts | Medium |

### 3.3. Missing Scenario Tests

- Empty streams (no commits)
- Streams with only merge commits
- Very deep hierarchies (>10 levels)
- Concurrent cascade rebases
- Recovery from partial failures
- Local mode stream edge cases
- Database corruption recovery
- Multiple agents modifying same stream

### 3.4. Test Quality Issues

- Most tests only cover happy paths
- No load/performance tests
- Limited concurrency testing
- Database layer not directly tested

---

## 4. Recommendations

### Immediate (Bug Fixes)

1. **Fix the async conflict handling** - Make `rebaseOntoStream` async
2. **Handle HEAD~1 edge case** - Check for initial commit
3. **Validate worktree paths** - Check existence before operations
4. **Fix null reference** - Handle deleted conflicts gracefully

### Short-term (Testing)

1. **Expand tracker.ts tests** - Target 50+ tests
2. **Add error path tests** - Test failure scenarios
3. **Add integration tests** for `mergeStream`, `syncWithParent`

### Medium-term (Architecture)

1. **Add reverse dependency index** - Improve lookup performance
2. **Implement proper state machine** - Formalize stream transitions
3. **Add transaction boundaries** - Ensure operation atomicity

### Long-term (Cleanup)

1. **Remove `paused` status** or implement it
2. **Remove deprecated APIs** after deprecation period
3. **Standardize import patterns** across codebase

---

## 5. Summary Statistics

| Metric | Value |
|--------|-------|
| Source Files | 37 |
| Test Files | 35 |
| Test/Source Ratio | 1.45:1 |
| Main API Test Coverage | ~3% |
| Bugs Identified | 10 |
| Critical Bugs | 1 |
| High Severity | 5 |
| Medium Severity | 4 |
