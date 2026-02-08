# Multi-Agent Git Tracking System

## Specification Document v0.1

---

## 1. Motivation

### 1.1 Problem Statement

We need to coordinate multiple AI agents working concurrently on a shared codebase. Each agent may:

- Work on independent features simultaneously
- Build upon another agent's in-progress work
- Need to rebase or merge changes as work streams converge
- Make mistakes that require rollback

Standard git workflows assume human-speed interactions with sequential operations. Multi-agent systems introduce challenges:

1. **Concurrent mutations**: Multiple agents modifying repo state simultaneously
2. **Visibility**: Agents need to see each other's in-progress work
3. **Dependency tracking**: Work streams fork and merge in complex graphs
4. **Reviewability**: Humans need to review and approve agent work before merging
5. **Recoverability**: Easy rollback when agents make mistakes or go down bad paths

### 1.2 Goals

| Goal | Priority | Description |
|------|----------|-------------|
| Isolation | P0 | Agents can work without interfering with each other |
| Traceability | P0 | Complete history of all agent operations |
| Rollback | P0 | Undo any agent's work to any prior state |
| Stacked diffs | P1 | Support reviewable, incremental commit stacks |
| Cross-stream rebasing | P1 | Rebase one agent's work onto another's |
| Dependency graph | P1 | Track fork/merge relationships between work streams |
| Human review gates | P2 | Require approval before merging to protected branches |
| Conflict resolution | P2 | Handle merge/rebase conflicts gracefully |
| Real-time visibility | P3 | Agents see each other's changes as they happen |

### 1.3 Non-Goals

- Replacing git (we build on top of it)
- Distributed multi-machine coordination (single machine, shared filesystem)
- Real-time collaborative editing (agents work on separate worktrees)
- Supporting non-git VCS backends

---

## 2. Design Overview

### 2.1 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Coordinator API                          │
│  (Python interface for agent orchestration systems)             │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                   MultiAgentRepoTracker                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │   Stream    │  │  Operation  │  │    Stack    │             │
│  │   Manager   │  │     Log     │  │   Manager   │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
└─────────────────────────────────────────────────────────────────┘
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
        ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
        │  TinyBase   │ │     Git     │ │  Worktrees  │
        │ (SQLite WAL)│ │ (or jj opt.)│ │ (isolation) │
        └─────────────┘ └─────────────┘ └─────────────┘
```

### 2.2 Core Concepts

#### Work Stream

A logical unit of work that may span multiple commits. Streams have:

- A unique identifier
- A human-readable name
- An owning agent
- A base commit (fork point)
- An optional parent stream (fork relationship)
- A status (active, paused, merged, abandoned)

Streams map 1:1 to git branches (`stream/{stream_id}`).

#### Operation

A single mutation to the repository state. Operations form a DAG (directed acyclic graph) enabling:

- Undo/rollback to any prior state
- Audit trail of all agent actions
- Understanding causal relationships between changes

#### Stack

An ordered list of commits within a stream, intended for incremental review. Each stack entry has:

- A commit hash
- A position in the stack
- A description
- A review status (draft, review, approved, merged)

#### Worktree

A git worktree providing filesystem isolation for each agent. Each agent gets their own worktree where they can make changes without affecting others.

---

## 3. Data Model

### 3.1 Stream

```python
@dataclass
class Stream:
    id: str                      # Unique identifier (e.g., "abc12345")
    name: str                    # Human-readable name (e.g., "feature-auth")
    agent_id: str                # Owning agent
    base_commit: str             # Commit hash where stream branched from
    parent_stream: Optional[str] # ID of parent stream if forked
    status: StreamStatus         # active | paused | merged | abandoned
    created_at: float            # Unix timestamp
    updated_at: float            # Unix timestamp
    merged_into: Optional[str]   # Target stream if merged
    enable_stacked_review: bool  # Opt-in: track commits as reviewable stack entries
    metadata: dict               # Extensible metadata
```

### 3.2 Operation

```python
@dataclass
class Operation:
    id: str                      # Unique identifier
    stream_id: str               # Stream this operation belongs to
    agent_id: str                # Agent that performed the operation
    op_type: OperationType       # See below
    before_state: str            # Commit hash before operation
    after_state: str             # Commit hash after operation
    parent_ops: list[str]        # Parent operation IDs (usually 1, can be 2 for merges)
    timestamp: float             # Unix timestamp
    metadata: dict               # Operation-specific data

class OperationType(Enum):
    COMMIT = "commit"            # New commit added
    AMEND = "amend"              # Existing commit modified
    REBASE = "rebase"            # Stream rebased onto new base
    MERGE = "merge"              # Another stream merged in
    CHERRY_PICK = "cherry_pick"  # Specific commit(s) copied
    ROLLBACK = "rollback"        # State rolled back
    RESET = "reset"              # Hard reset to specific commit
    STACK_REORDER = "stack_reorder"  # Stack entries reordered
```

### 3.3 Stack Entry

```python
@dataclass
class StackEntry:
    id: str                      # Unique identifier
    stream_id: str               # Parent stream
    commit: str                  # Current commit hash (changes on rebase)
    position: int                # Order in stack (0 = bottom/oldest)
    description: str             # Commit message or custom description
    review_status: ReviewStatus  # draft | review | approved | merged
    reviewed_by: Optional[str]   # Reviewer identifier
    reviewed_at: Optional[float] # Review timestamp
    original_commit: str         # Original commit hash (stable across rebases)
```

### 3.4 Agent Worktree

```python
@dataclass
class AgentWorktree:
    agent_id: str                # Agent identifier
    path: str                    # Filesystem path to worktree
    current_stream: Optional[str]  # Stream currently checked out
    created_at: float            # Unix timestamp
    last_active: float           # Last operation timestamp
```

---

## 4. Core Operations

### 4.1 Stream Lifecycle

#### Create Stream

```python
def create_stream(
    name: str,
    agent_id: str,
    base: str = "main",
    parent_stream: Optional[str] = None,
    enable_stacked_review: bool = False  # Opt-in for review workflow
) -> str:
    """
    Create a new work stream.

    1. Resolve base to commit hash
    2. Generate stream ID
    3. Create git branch stream/{id} at base
    4. Record stream in database
    5. Record initial operation

    Args:
        name: Human-readable name for the stream
        agent_id: ID of the owning agent
        base: Branch or commit to base from (default: main)
        parent_stream: Optional parent stream ID if forking
        enable_stacked_review: If True, track commits as reviewable stack entries

    Returns: stream_id
    """
```

#### Fork Stream

```python
def fork_stream(
    parent_stream_id: str,
    name: str,
    agent_id: str
) -> str:
    """
    Create a new stream branching from an existing stream's head.
    
    1. Get current head of parent stream
    2. Create new stream with parent_stream set
    3. Base commit = parent's current head
    
    Returns: new stream_id
    """
```

#### Merge Stream

```python
def merge_stream(
    source_stream: str,
    target_stream: str,
    agent_id: str,
    worktree: str,
    strategy: MergeStrategy = MergeStrategy.MERGE_COMMIT
) -> MergeResult:
    """
    Merge source stream into target stream.
    
    Strategies:
    - MERGE_COMMIT: Create a merge commit
    - SQUASH: Squash all commits into one
    - REBASE: Rebase source onto target (no merge commit)
    
    Returns: MergeResult with success status, conflicts if any
    """
```

#### Abandon Stream

```python
def abandon_stream(stream_id: str, reason: str = None) -> None:
    """
    Mark a stream as abandoned.
    
    Does not delete git branch (for recovery).
    Records abandonment in operation log.
    """
```

### 4.2 Stack Operations

#### Add to Stack

```python
def add_to_stack(
    stream_id: str,
    commit: str,
    description: Optional[str] = None
) -> int:
    """
    Add a commit to a stream's review stack.
    
    If description not provided, uses commit message.
    Returns: position in stack
    """
```

#### Reorder Stack

```python
def reorder_stack(
    stream_id: str,
    new_order: list[str],  # List of stack entry IDs in new order
    agent_id: str,
    worktree: str
) -> bool:
    """
    Reorder commits in a stack.
    
    Uses interactive rebase under the hood.
    Records operation for rollback.
    
    Returns: success status
    """
```

#### Update Stack Entry Review Status

```python
def set_review_status(
    stack_entry_id: str,
    status: ReviewStatus,
    reviewer: Optional[str] = None
) -> None:
    """
    Update review status of a stack entry.
    """
```

### 4.3 Rebase Operations

#### Rebase onto Stream

```python
def rebase_onto_stream(
    source_stream: str,
    target_stream: str,
    agent_id: str,
    worktree: str,
    conflict_handler: Optional[ConflictHandler] = None
) -> RebaseResult:
    """
    Rebase source stream's commits onto target stream's head.
    
    1. Get source's commits since its base
    2. Rebase them onto target's head
    3. Update source's base_commit to target's head
    4. Rebuild stack with new commit hashes
    5. Record operation
    
    If conflicts occur:
    - If conflict_handler provided, call it for each conflict
    - If not provided, abort and return failure
    
    Returns: RebaseResult with new head, updated stack, any conflicts
    """
```

#### Sync with Parent

```python
def sync_with_parent(
    stream_id: str,
    agent_id: str,
    worktree: str
) -> RebaseResult:
    """
    Convenience method to rebase onto parent stream's current head.
    """
```

#### Cascade Rebase

```python
def cascade_rebase(
    stream_id: str,
    agent_id: str,
    worktrees: dict[str, str]
) -> dict[str, RebaseResult]:
    """
    After updating a stream, rebase all dependent streams.
    
    Walks the stream dependency tree depth-first.
    Stops on first failure in any branch.
    
    Returns: dict mapping stream_id to result
    """
```

### 4.4 Rollback Operations

#### Rollback to Operation

```python
def rollback_to_operation(
    stream_id: str,
    operation_id: str,
    worktree: str
) -> None:
    """
    Roll back stream to state after a specific operation.
    
    1. Find operation in log
    2. Reset stream branch to operation's after_state
    3. Rebuild stack from commits
    4. Record rollback operation
    """
```

#### Rollback N Operations

```python
def rollback_n(
    stream_id: str,
    n: int,
    worktree: str
) -> None:
    """
    Roll back the last N operations on a stream.
    """
```

#### Rollback to Fork Point

```python
def rollback_to_fork_point(
    stream_id: str,
    worktree: str
) -> None:
    """
    Reset stream to its original base commit.
    Clears entire stack.
    """
```

### 4.5 Query Operations

#### Get Stream Graph

```python
def get_stream_graph() -> StreamGraph:
    """
    Get the full graph of streams and their relationships.
    
    Returns: StreamGraph with nodes (streams) and edges (fork/merge relationships)
    """
```

#### Get Operation DAG

```python
def get_operation_dag(
    stream_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    since: Optional[float] = None
) -> list[Operation]:
    """
    Get operations matching filters, ordered by timestamp.
    """
```

#### Get Stack

```python
def get_stack(stream_id: str) -> list[StackEntry]:
    """
    Get ordered stack entries for a stream.
    """
```

#### Find Common Ancestor

```python
def find_common_ancestor(stream_a: str, stream_b: str) -> str:
    """
    Find the common ancestor commit of two streams.
    Useful for planning merges/rebases.
    """
```

---

## 5. Design Decisions

### 5.1 Why Git Worktrees (Not Git Branches Alone)

**Decision**: Each agent gets a dedicated worktree.

**Rationale**:
- Agents can have uncommitted changes without affecting each other
- No need to stash/unstash when switching contexts
- Parallel filesystem operations (builds, tests) are isolated
- Matches how human developers use separate clones

**Trade-offs**:
- Disk space: Each worktree duplicates working files
- Complexity: Must track worktree-to-agent mapping
- Git limitations: Can't checkout same branch in multiple worktrees

### 5.2 Why TinyBase + SQLite WAL

**Decision**: Use TinyBase with SQLite in WAL mode for metadata storage.

**Rationale**:
- SQLite WAL mode provides concurrent read/write access
- Multiple agents can safely write to different streams simultaneously
- TinyBase provides a clean Python interface with minimal boilerplate
- Sufficient for expected scale (10+ concurrent agents, thousands of operations)
- Single-file database simplifies deployment and backup

**Trade-offs**:
- Slightly more complex than pure JSON storage
- Requires SQLite (ubiquitous, but still a dependency)
- Binary format less human-readable than JSON (mitigated by query tools)

**Why not TinyDB**:
- TinyDB rewrites entire JSON file on each write
- Not safe for concurrent writes from multiple agents
- Would require file locking or single-writer pattern

### 5.3 Why Streams (Not Just Branches)

**Decision**: Introduce "stream" as first-class concept above git branches.

**Rationale**:
- Branches are an implementation detail
- Streams carry semantic meaning (ownership, purpose, relationships)
- Can track metadata that doesn't belong in git
- Enables fork/merge relationship tracking

**Trade-offs**:
- Conceptual overhead
- Must keep stream state in sync with branch state
- Stream could diverge from actual git state if not careful

### 5.4 Rebase-First Workflow

**Decision**: Default to rebase-based workflows, not merge commits.

**Rationale**:
- Cleaner history for review
- Stacked diffs work better with linear history
- Easier to reason about for automated agents
- Matches modern development practices (GitHub squash-merge, Gerrit)

**Trade-offs**:
- Rebase rewrites history (commit hashes change)
- Must update all tracking when commits change
- More conflict potential than merge commits
- Loses exact "when did this happen" information

### 5.5 Stack Rebuilding Strategy

**Decision**: Rebuild stack from git commits after rebase.

**Rationale**:
- Git is source of truth for commit structure
- Avoids complex hash-mapping logic
- Simple recovery if stack gets out of sync

**Trade-offs**:
- Loses stack metadata that doesn't map to commits
- Review status must be re-mapped (by original_commit field)
- Position might change if commits squashed/split

### 5.6 jj-Compatible Interface Design

**Decision**: Design interfaces around jj concepts even with git backend.

**Rationale**:
- jj may be adopted as backend in the future
- jj's concepts (changes, operations) are cleaner abstractions
- Makes swap easier without breaking client code
- Keeps package lightweight now, extensible later

**Key jj concepts we adopt**:

| jj Concept | Our Implementation (git backend) | Future (jj backend) |
|------------|----------------------------------|---------------------|
| Change | Change-Id in commit trailer + tracking table | Native change ID |
| Operation | Operation log in SQLite | Native operation log |
| Conflict | Deferred conflict records | First-class conflicts |
| Working copy | Git worktree | jj working copy |

**Interface abstraction**:

```python
class VCSBackend(Protocol):
    """
    Abstract interface for version control operations.
    Implemented by GitBackend (now) and JJBackend (future).
    """

    def create_change(self, description: str) -> ChangeId:
        """Create a new change (maps to commit in git, change in jj)."""
        ...

    def describe_change(self, change_id: ChangeId, description: str) -> None:
        """Update change description."""
        ...

    def get_change(self, change_id: ChangeId) -> Change:
        """Get change by stable ID."""
        ...

    def rebase_change(self, change_id: ChangeId, onto: ChangeId) -> RebaseResult:
        """Rebase a change onto another."""
        ...

    def get_conflicts(self, change_id: ChangeId) -> list[Conflict]:
        """Get conflicts in a change (empty for git unless using deferral mode)."""
        ...
```

**What we defer to jj backend**:
- Lock-free concurrent mutations
- First-class conflict storage
- Automatic operation undo
- Anonymous branches

---

## 6. Concurrency Model

### 6.1 Approach: SQLite WAL + Stream-Level Coordination

The design leverages SQLite WAL mode for database-level concurrency, with stream-level coordination enforced by the external coordinator:

- **Database writes**: SQLite WAL allows concurrent writes from multiple agents
- **Stream ownership**: One agent writes to a stream at a time (coordinator-enforced)
- **Cross-stream operations**: Multiple agents can work on different streams simultaneously

```python
class StreamLock:
    """
    Stream-level locking for operations that require exclusive access.

    SQLite WAL handles database concurrency. This lock ensures logical
    consistency for multi-step git operations on a single stream.
    """

    def __init__(self, db: Database):
        # Using TinyBase/SQLite - concurrent-safe
        self.locks = db.table('stream_locks')

    def acquire(self, stream_id: str, agent_id: str, timeout: float = 30) -> bool:
        """
        Acquire exclusive lock on a stream.

        Uses SQLite's atomic operations - no race conditions.
        """
        now = time.time()

        with self.db.transaction():
            existing = self.locks.get(stream_id=stream_id)

            if existing:
                if existing.agent_id == agent_id:
                    # Already own it, refresh
                    self.locks.update(stream_id=stream_id, acquired_at=now)
                    return True
                if now - existing.acquired_at > timeout:
                    # Lock expired, take over
                    self.locks.update(
                        stream_id=stream_id,
                        agent_id=agent_id,
                        acquired_at=now
                    )
                    return True
                return False  # Lock held by another agent

            self.locks.insert(
                stream_id=stream_id,
                agent_id=agent_id,
                acquired_at=now
            )
            return True

    def release(self, stream_id: str, agent_id: str) -> None:
        self.locks.delete(stream_id=stream_id, agent_id=agent_id)
```

### 6.2 Concurrency Guarantees

| Layer | Mechanism | Guarantees |
|-------|-----------|------------|
| Database | SQLite WAL | Concurrent reads/writes, ACID transactions |
| Stream | StreamLock | One writer per stream, timeout-based recovery |
| Coordinator | External | Agent-to-stream assignment, handoff management |

### 6.3 What the Coordinator Must Ensure

The external coordinator is responsible for:

1. Assigning streams to agents (one active writer per stream)
2. Managing handoffs when work transfers between agents
3. Detecting crashed agents and releasing their locks
4. Notifying agents when their stream's parent changes

This git-cascade provides defensive checks but trusts the coordinator for correctness.

---

## 7. Addressing Known Gaps

This section documents limitations compared to more sophisticated systems (like jj) and our mitigation strategies.

### 7.1 Concurrency Model

#### The Constraint

Multiple agents cannot safely write to the **same stream** simultaneously:

```
Agent A                         Agent B
────────                        ────────
read stream head: abc123        read stream head: abc123
create commit def456            create commit 789xyz
update branch → def456          update branch → 789xyz
                                ← Agent A's commit is orphaned!
```

However, agents on **different streams** can work fully concurrently.

#### Our Model: Parallel Streams with Branching/Merging

Multiple agents working on the same issue use **parallel streams** that branch and merge:

```
                    main
                      │
         ┌────────────┴────────────┐
         ▼                         ▼
    stream-auth-1              stream-auth-2
    (agent-1)                  (agent-2)
         │                         │
         └──────────┬──────────────┘
                    ▼
              stream-auth-merged
              (coordinator merges)
```

This provides:
- Full isolation during development
- Clear merge points for integration
- No concurrent write conflicts

#### Coordinator Contract

The external coordinator must ensure:

```python
class CoordinatorContract:
    """
    Contract the coordinator must uphold.
    This is NOT implemented here - it's the coordinator's responsibility.
    """

    def assign_stream(self, stream_id: str, agent_id: str) -> bool:
        """
        Assign exclusive write access to an agent.
        Returns False if stream is already assigned.
        """
        ...

    def release_stream(self, stream_id: str, agent_id: str) -> None:
        """Release write access."""
        ...

    def transfer_stream(self, stream_id: str, from_agent: str, to_agent: str) -> bool:
        """Atomically transfer ownership."""
        ...
```

#### Defensive Measures

SQLite WAL handles database concurrency. Stream locks (Section 6) provide additional safety:

```python
class StreamGuard:
    """
    Lightweight guard against accidental concurrent access.
    Uses SQLite transactions - safe for concurrent access.
    """

    def __init__(self, db: Database):
        self.guards = db.table('stream_guards')

    def check_and_set(self, stream_id: str, agent_id: str) -> bool:
        """
        Attempt to become the active writer.
        Fails if another agent is active and recently wrote.
        """
        now = time.time()
        stale_threshold = 60  # seconds

        with self.db.transaction():
            existing = self.guards.get(stream_id=stream_id)

            if existing:
                if existing.agent_id != agent_id:
                    if now - existing.last_write < stale_threshold:
                        return False  # Another agent is actively writing

            self.guards.upsert(
                stream_id=stream_id,
                agent_id=agent_id,
                last_write=now
            )
            return True

    def touch(self, stream_id: str, agent_id: str) -> None:
        """Update last_write timestamp during long operations."""
        self.guards.update(stream_id=stream_id, agent_id=agent_id, last_write=time.time())

    def release(self, stream_id: str, agent_id: str) -> None:
        """Explicitly release guard."""
        self.guards.delete(stream_id=stream_id, agent_id=agent_id)
```

#### What We Explicitly Don't Support

- Multiple agents writing to same stream simultaneously
- Automatic merge of divergent operation histories
- Lock-free concurrent mutations

These require data structures we don't have (content-addressed operation log, CRDT-like merge). Future jj backend would provide these.

---

### 7.2 Stable Change Identity

#### The Problem

Git commits are identified by hash, which changes on any rewrite:

```
Original: abc123 "add feature"
After rebase: def456 "add feature"  ← Same content, different identity
```

jj solves this with "change IDs" - stable identifiers that survive rewrites.

#### Our Solution: Commit Message Trailers + Tracking Table

We use **Gerrit-style commit message trailers** as the primary identity mechanism. The Change-Id lives in the commit message and survives rebases naturally:

```
feat: add user authentication

Implements OAuth2 flow with refresh tokens.

Change-Id: c-a1b2c3d4
```

This is combined with a tracking table for history and edge case handling.

```python
def extract_change_id(commit_msg: str) -> Optional[str]:
    """Parse Change-Id trailer from commit message."""
    for line in reversed(commit_msg.strip().split('\n')):
        if line.startswith('Change-Id: '):
            return line.split(': ', 1)[1]
    return None

def ensure_change_id(commit_msg: str) -> str:
    """Add Change-Id trailer if missing."""
    if extract_change_id(commit_msg):
        return commit_msg
    change_id = f"c-{uuid.uuid4().hex[:8]}"
    return f"{commit_msg.rstrip()}\n\nChange-Id: {change_id}"
```

#### Tracking Table (for history and edge cases)

```python
@dataclass
class Change:
    """
    A logical change that may be rewritten multiple times.
    """
    id: str                      # Stable UUID
    stream_id: str               # Parent stream
    description: str             # Human description (may differ from commit msg)
    
    # Commit history (newest first)
    commit_history: list[CommitRecord]
    
    # Current state
    current_commit: Optional[str]  # None if change was dropped/squashed away
    status: ChangeStatus           # active | squashed | dropped | merged

@dataclass  
class CommitRecord:
    commit: str                  # Git commit hash
    recorded_at: float           # When we recorded this
    reason: str                  # "initial" | "rebase" | "amend" | "squash_target"
```

```python
class ChangeTracker:
    """Track logical changes across rewrites."""
    
    def __init__(self, db: TinyDB):
        self.changes = db.table('changes')
    
    def create_change(self, stream_id: str, commit: str, description: str) -> str:
        """Create a new tracked change."""
        change_id = str(uuid.uuid4())[:12]
        
        self.changes.insert({
            'id': change_id,
            'stream_id': stream_id,
            'description': description,
            'commit_history': [{
                'commit': commit,
                'recorded_at': time.time(),
                'reason': 'initial'
            }],
            'current_commit': commit,
            'status': 'active'
        })
        return change_id
    
    def record_rewrite(
        self, 
        change_id: str, 
        new_commit: str, 
        reason: str = "rebase"
    ) -> None:
        """Record that a change was rewritten to a new commit."""
        Q = Query()
        change = self.changes.get(Q.id == change_id)
        
        history = change['commit_history']
        history.insert(0, {
            'commit': new_commit,
            'recorded_at': time.time(),
            'reason': reason
        })
        
        self.changes.update({
            'commit_history': history,
            'current_commit': new_commit
        }, Q.id == change_id)
    
    def record_squash(
        self, 
        absorbed_change_ids: list[str], 
        target_change_id: str,
        resulting_commit: str
    ) -> None:
        """Record that changes were squashed into one."""
        Q = Query()
        
        # Mark absorbed changes
        for cid in absorbed_change_ids:
            self.changes.update({
                'status': 'squashed',
                'squashed_into': target_change_id,
                'current_commit': None
            }, Q.id == cid)
        
        # Update target
        self.record_rewrite(target_change_id, resulting_commit, 'squash_target')
    
    def record_split(
        self,
        original_change_id: str,
        new_commits: list[tuple[str, str]]  # [(commit, description), ...]
    ) -> list[str]:
        """Record that a change was split into multiple."""
        Q = Query()
        original = self.changes.get(Q.id == original_change_id)
        
        # Mark original as split
        self.changes.update({
            'status': 'split',
            'current_commit': None
        }, Q.id == original_change_id)
        
        # Create new changes
        new_ids = []
        for commit, desc in new_commits:
            new_id = self.create_change(original['stream_id'], commit, desc)
            self.changes.update({
                'split_from': original_change_id
            }, Q.id == new_id)
            new_ids.append(new_id)
        
        return new_ids
    
    def find_by_commit(self, commit: str) -> Optional[dict]:
        """Find change that currently points to this commit."""
        Q = Query()
        return self.changes.get(Q.current_commit == commit)
    
    def find_by_historical_commit(self, commit: str) -> Optional[dict]:
        """Find change that ever pointed to this commit."""
        for change in self.changes.all():
            for record in change['commit_history']:
                if record['commit'] == commit:
                    return change
        return None
    
    def rebuild_after_rebase(
        self, 
        stream_id: str,
        old_base: str,
        new_base: str,
        commit_mapping: dict[str, str]  # old_commit → new_commit
    ) -> None:
        """Update all changes in a stream after rebase."""
        Q = Query()
        changes = self.changes.search(
            (Q.stream_id == stream_id) & (Q.status == 'active')
        )
        
        for change in changes:
            old_commit = change['current_commit']
            if old_commit in commit_mapping:
                new_commit = commit_mapping[old_commit]
                self.record_rewrite(change['id'], new_commit, 'rebase')
```

#### Building the Commit Mapping After Rebase

```python
def get_rebase_commit_mapping(
    self,
    worktree: str,
    old_base: str,
    new_base: str,
    old_head: str,
    new_head: str
) -> dict[str, str]:
    """
    Build old→new commit mapping after a rebase.
    
    Uses patch-id matching: commits with same diff get matched.
    """
    # Get old commits
    old_commits = self._git(
        "rev-list", "--reverse", f"{old_base}..{old_head}",
        worktree=worktree
    ).strip().split('\n')
    
    # Get new commits  
    new_commits = self._git(
        "rev-list", "--reverse", f"{new_base}..{new_head}",
        worktree=worktree
    ).strip().split('\n')
    
    # Build patch-id index for old commits
    old_patch_ids = {}
    for commit in old_commits:
        patch_id = self._git(
            "show", commit, "--format=", 
            worktree=worktree
        )
        # Hash the diff content
        patch_hash = hashlib.sha256(patch_id.encode()).hexdigest()[:16]
        old_patch_ids[patch_hash] = commit
    
    # Match new commits
    mapping = {}
    for commit in new_commits:
        patch_id = self._git(
            "show", commit, "--format=",
            worktree=worktree
        )
        patch_hash = hashlib.sha256(patch_id.encode()).hexdigest()[:16]
        
        if patch_hash in old_patch_ids:
            old_commit = old_patch_ids[patch_hash]
            mapping[old_commit] = commit
    
    return mapping
```

#### Limitations

- Squash/split require explicit recording (can't auto-detect reliably)
- Patch-id matching can fail if commit content changed during rebase conflict resolution
- Historical lookup is O(n) - fine for expected scale, would need indexing at large scale

---

### 7.3 Conflict Handling

#### The Problem

Standard git rebase stops at first conflict, requiring immediate resolution:

```bash
$ git rebase main
CONFLICT (content): Merge conflict in file.py
error: could not apply abc123... 
hint: Resolve all conflicts manually, then run "git rebase --continue"
```

jj records conflicts in the commit and continues, allowing deferred resolution.

#### Our Mitigation: Conflict Deferral Mode

We can't get true first-class conflicts without modifying how files are stored, but we can approximate deferred resolution:

```python
@dataclass
class ConflictRecord:
    """Record of a conflict encountered during rebase."""
    id: str
    stream_id: str
    operation_id: str            # Operation that hit the conflict
    conflicting_commit: str       # The commit being rebased
    target_commit: str            # What we're rebasing onto
    conflicted_files: list[str]
    conflict_markers: dict[str, str]  # file → content with markers
    status: str                   # pending | resolved | skipped
    created_at: float
    resolved_at: Optional[float]
    resolution: Optional[str]     # How it was resolved

class ConflictDeferralMode:
    """
    Alternative rebase strategy that records conflicts instead of blocking.
    
    Trade-off: Creates commits with conflict markers in them.
    Reviewers will see the markers until resolved.
    """
    
    def __init__(self, tracker: 'MultiAgentRepoTracker'):
        self.tracker = tracker
        self.conflicts = tracker.db.table('conflicts')
    
    def rebase_with_deferral(
        self,
        stream_id: str,
        onto: str,
        agent_id: str,
        worktree: str
    ) -> RebaseResult:
        """
        Rebase that continues through conflicts.
        
        Strategy:
        1. For each commit, attempt cherry-pick
        2. If conflict, record it and commit with markers
        3. Continue to next commit
        4. Return list of deferred conflicts
        """
        Q = Query()
        stream = self.tracker.streams.get(Q.id == stream_id)
        
        old_head = self._git("rev-parse", f"stream/{stream_id}")
        base = stream['base_commit']
        
        # Get commits to rebase
        commits = self._git(
            "rev-list", "--reverse", f"{base}..{old_head}",
            worktree=worktree
        ).strip().split('\n')
        
        # Start from target
        self._git("checkout", "--detach", onto, worktree=worktree)
        
        deferred_conflicts = []
        new_commits = []
        
        for commit in commits:
            result = subprocess.run(
                ["git", "cherry-pick", "--no-commit", commit],
                cwd=worktree,
                capture_output=True
            )
            
            if result.returncode != 0:
                # Conflict - record and continue
                conflicted = self._get_conflicted_files(worktree)
                
                conflict_record = {
                    'id': str(uuid.uuid4())[:8],
                    'stream_id': stream_id,
                    'conflicting_commit': commit,
                    'target_commit': onto,
                    'conflicted_files': conflicted,
                    'conflict_markers': {
                        f: self._read_file(worktree, f) 
                        for f in conflicted
                    },
                    'status': 'pending',
                    'created_at': time.time()
                }
                self.conflicts.insert(conflict_record)
                deferred_conflicts.append(conflict_record)
                
                # Stage conflicted files as-is (with markers)
                self._git("add", "--all", worktree=worktree)
            
            # Commit (with or without conflict markers)
            msg = self._git("log", "-1", "--format=%B", commit, worktree=worktree)
            self._git("commit", "-m", msg, worktree=worktree)
            new_commits.append(self._git("rev-parse", "HEAD", worktree=worktree))
        
        # Update branch
        new_head = self._git("rev-parse", "HEAD", worktree=worktree)
        self._git("branch", "-f", f"stream/{stream_id}", new_head, worktree=worktree)
        
        return RebaseResult(
            success=True,  # Rebase completed (conflicts deferred)
            old_head=old_head,
            new_head=new_head,
            deferred_conflicts=deferred_conflicts
        )
    
    def get_pending_conflicts(self, stream_id: str) -> list[dict]:
        """Get unresolved conflicts for a stream."""
        Q = Query()
        return self.conflicts.search(
            (Q.stream_id == stream_id) & (Q.status == 'pending')
        )
    
    def resolve_conflict(
        self,
        conflict_id: str,
        resolved_content: dict[str, str],  # file → resolved content
        agent_id: str,
        worktree: str
    ) -> str:
        """
        Apply conflict resolution.
        
        Creates an "amendment" commit that replaces conflict markers
        with resolved content.
        """
        Q = Query()
        conflict = self.conflicts.get(Q.id == conflict_id)
        
        # Write resolved content
        for filepath, content in resolved_content.items():
            full_path = os.path.join(worktree, filepath)
            with open(full_path, 'w') as f:
                f.write(content)
        
        # Amend or create fixup commit
        self._git("add", "--all", worktree=worktree)
        self._git("commit", "--amend", "--no-edit", worktree=worktree)
        
        new_commit = self._git("rev-parse", "HEAD", worktree=worktree)
        
        # Update conflict record
        self.conflicts.update({
            'status': 'resolved',
            'resolved_at': time.time(),
            'resolution_commit': new_commit
        }, Q.id == conflict_id)
        
        return new_commit
```

#### Conflict Detection Helper

```python
def has_unresolved_conflicts(self, stream_id: str) -> bool:
    """Check if stream has commits with conflict markers."""
    pending = self.get_pending_conflicts(stream_id)
    return len(pending) > 0

def block_merge_if_conflicts(self, stream_id: str) -> None:
    """Raise error if trying to merge stream with conflicts."""
    if self.has_unresolved_conflicts(stream_id):
        conflicts = self.get_pending_conflicts(stream_id)
        raise UnresolvedConflictsError(
            f"Stream {stream_id} has {len(conflicts)} unresolved conflicts",
            conflicts=conflicts
        )
```

#### Limitations vs jj

| Aspect | jj | Our approach |
|--------|-----|--------------|
| Conflict storage | Native format, invisible to users | Visible markers in file content |
| Partial resolution | Resolve individual conflicts | Must resolve all in a file |
| Conflict in history | Clean after resolution | Markers visible in intermediate commits |
| Auto-propagation | Conflicts flow through descendants | Must manually re-resolve |

---

### 7.4 Cascade Rebase Through Complex Graphs

#### The Problem

When a base stream is updated, all dependent streams need rebasing:

```
Simple (supported):
main → A → B → C

Fan-out (supported):
main → A → B
       ├→ C  
       └→ D

Diamond (complex):
main → A → B ─┬→ E (merge of B,C,D)
       ├→ C ─┤
       └→ D ─┘
```

#### Our Approach: Explicit Dependency Graph

```python
@dataclass
class StreamDependency:
    """Explicit dependency declaration."""
    stream_id: str
    depends_on: list[str]        # Stream IDs this depends on
    dependency_type: str         # "fork" | "merge" | "rebase_onto"
    
class DependencyGraph:
    """
    Manages stream dependencies and cascade operations.
    """
    
    def __init__(self, db: TinyDB):
        self.deps = db.table('dependencies')
    
    def add_fork_dependency(self, child: str, parent: str) -> None:
        """Record that child was forked from parent."""
        Q = Query()
        existing = self.deps.get(Q.stream_id == child)
        
        if existing:
            deps = existing['depends_on']
            if parent not in deps:
                deps.append(parent)
                self.deps.update({'depends_on': deps}, Q.stream_id == child)
        else:
            self.deps.insert({
                'stream_id': child,
                'depends_on': [parent],
                'dependency_type': 'fork'
            })
    
    def add_merge_dependency(self, target: str, sources: list[str]) -> None:
        """Record that target is a merge of sources."""
        Q = Query()
        self.deps.upsert({
            'stream_id': target,
            'depends_on': sources,
            'dependency_type': 'merge'
        }, Q.stream_id == target)
    
    def get_dependents(self, stream_id: str) -> list[str]:
        """Get streams that directly depend on this one."""
        Q = Query()
        all_deps = self.deps.all()
        return [
            d['stream_id'] for d in all_deps 
            if stream_id in d['depends_on']
        ]
    
    def get_all_dependents(self, stream_id: str) -> list[str]:
        """Get transitive closure of dependents."""
        result = []
        queue = self.get_dependents(stream_id)
        seen = set()
        
        while queue:
            current = queue.pop(0)
            if current in seen:
                continue
            seen.add(current)
            result.append(current)
            queue.extend(self.get_dependents(current))
        
        return result
    
    def topological_sort(self, stream_ids: list[str]) -> list[str]:
        """Sort streams so dependencies come before dependents."""
        # Build in-degree map
        in_degree = {s: 0 for s in stream_ids}
        graph = {s: [] for s in stream_ids}
        
        Q = Query()
        for sid in stream_ids:
            dep = self.deps.get(Q.stream_id == sid)
            if dep:
                for parent in dep['depends_on']:
                    if parent in stream_ids:
                        graph[parent].append(sid)
                        in_degree[sid] += 1
        
        # Kahn's algorithm
        queue = [s for s in stream_ids if in_degree[s] == 0]
        result = []
        
        while queue:
            current = queue.pop(0)
            result.append(current)
            for child in graph[current]:
                in_degree[child] -= 1
                if in_degree[child] == 0:
                    queue.append(child)
        
        if len(result) != len(stream_ids):
            raise CyclicDependencyError("Dependency graph has cycles")
        
        return result
    
    def get_dependency_type(self, stream_id: str) -> Optional[str]:
        """Get how this stream depends on its parents."""
        Q = Query()
        dep = self.deps.get(Q.stream_id == stream_id)
        return dep['dependency_type'] if dep else None
```

#### Cascade Rebase Implementation

```python
class CascadeRebase:
    """
    Handles cascade rebase through complex dependency graphs.
    """
    
    def __init__(self, tracker: 'MultiAgentRepoTracker'):
        self.tracker = tracker
        self.dep_graph = DependencyGraph(tracker.db)
    
    def cascade(
        self,
        root_stream: str,
        agent_id: str,
        worktree_provider: Callable[[str], str],
        strategy: CascadeStrategy = CascadeStrategy.STOP_ON_CONFLICT
    ) -> CascadeResult:
        """
        Cascade rebase to all dependents of root_stream.
        
        Strategies:
        - STOP_ON_CONFLICT: Stop entire cascade at first conflict
        - DEFER_CONFLICTS: Continue with conflict markers
        - SKIP_CONFLICTING: Skip streams that would conflict
        - INTERACTIVE: Call handler for each conflict
        """
        # Find all affected streams
        dependents = self.dep_graph.get_all_dependents(root_stream)
        
        if not dependents:
            return CascadeResult(success=True, updated=[])
        
        # Sort topologically
        ordered = self.dep_graph.topological_sort(dependents)
        
        results = {}
        failed = []
        
        for stream_id in ordered:
            # Check if any dependency failed
            dep_info = self.dep_graph.deps.get(Query().stream_id == stream_id)
            if dep_info:
                failed_deps = [d for d in dep_info['depends_on'] if d in failed]
                if failed_deps:
                    results[stream_id] = RebaseResult(
                        success=False,
                        error=f"Skipped: dependencies failed: {failed_deps}"
                    )
                    failed.append(stream_id)
                    continue
            
            # Get worktree
            try:
                wt = worktree_provider(stream_id)
            except Exception as e:
                results[stream_id] = RebaseResult(success=False, error=str(e))
                failed.append(stream_id)
                continue
            
            # Determine rebase target
            dep_type = self.dep_graph.get_dependency_type(stream_id)
            
            if dep_type == 'fork':
                # Simple case: rebase onto parent's new head
                parent = dep_info['depends_on'][0]
                result = self._rebase_onto_parent(stream_id, parent, agent_id, wt, strategy)
                
            elif dep_type == 'merge':
                # Complex case: multiple parents
                result = self._handle_merge_dependency(
                    stream_id, dep_info['depends_on'], agent_id, wt, strategy
                )
            else:
                result = RebaseResult(success=True)  # No dependencies
            
            results[stream_id] = result
            
            if not result.success and strategy == CascadeStrategy.STOP_ON_CONFLICT:
                break
            
            if not result.success:
                failed.append(stream_id)
        
        return CascadeResult(
            success=len(failed) == 0,
            updated=[s for s in ordered if s not in failed],
            failed=failed,
            results=results
        )
    
    def _handle_merge_dependency(
        self,
        stream_id: str,
        parents: list[str],
        agent_id: str,
        worktree: str,
        strategy: CascadeStrategy
    ) -> RebaseResult:
        """
        Handle stream that was created by merging multiple parents.
        
        Strategy: Find new merge base, re-merge.
        """
        Q = Query()
        stream = self.tracker.streams.get(Q.id == stream_id)
        
        # Get new heads of all parents
        parent_heads = [
            self.tracker._git("rev-parse", f"stream/{p}")
            for p in parents
        ]
        
        # Find their merge base
        if len(parent_heads) == 2:
            merge_base = self.tracker._git(
                "merge-base", parent_heads[0], parent_heads[1]
            )
        else:
            # Octopus merge base
            merge_base = self.tracker._git(
                "merge-base", "--octopus", *parent_heads
            )
        
        # Check if stream has additional commits beyond the merge
        stream_head = self.tracker._git("rev-parse", f"stream/{stream_id}")
        commits_after_merge = self.tracker._git(
            "rev-list", f"{stream['base_commit']}..{stream_head}",
            worktree=worktree
        ).strip().split('\n')
        
        # This is complex - for now, warn and skip
        return RebaseResult(
            success=False,
            error="Merge-based streams require manual rebase",
            requires_manual=True,
            parent_heads=parent_heads
        )
```

#### Limitations

| Scenario | Support |
|----------|---------|
| Linear chain | Full |
| Fan-out | Full |
| Diamond/merge | Detection only, manual resolution required |
| Circular dependencies | Detected and rejected |

---

### 7.5 Working Copy Snapshots

#### The Problem

jj automatically snapshots uncommitted work. If you're mid-edit and run a command, your work is safe.

Git (and our tracker) can lose uncommitted work during rebase/reset.

#### Our Mitigation: Explicit Snapshot Commands

```python
class WorkingCopySnapshot:
    """
    Snapshot uncommitted changes before dangerous operations.
    """
    
    def __init__(self, db: TinyDB):
        self.snapshots = db.table('wc_snapshots')
    
    def snapshot(self, worktree: str, agent_id: str, reason: str) -> str:
        """
        Create a snapshot of current working copy state.
        
        Uses git stash internally but tracks it ourselves.
        """
        # Check if there's anything to snapshot
        status = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=worktree, capture_output=True, text=True
        )
        
        if not status.stdout.strip():
            return None  # Nothing to snapshot
        
        # Create stash
        subprocess.run(
            ["git", "stash", "push", "-m", f"snapshot:{agent_id}:{reason}"],
            cwd=worktree
        )
        
        # Get stash ref
        stash_ref = subprocess.run(
            ["git", "stash", "list", "-1", "--format=%H"],
            cwd=worktree, capture_output=True, text=True
        ).stdout.strip()
        
        snapshot_id = str(uuid.uuid4())[:8]
        
        self.snapshots.insert({
            'id': snapshot_id,
            'worktree': worktree,
            'agent_id': agent_id,
            'reason': reason,
            'stash_ref': stash_ref,
            'head_at_snapshot': subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=worktree, capture_output=True, text=True
            ).stdout.strip(),
            'created_at': time.time()
        })
        
        return snapshot_id
    
    def restore(self, snapshot_id: str, worktree: str) -> bool:
        """Restore a snapshot."""
        Q = Query()
        snapshot = self.snapshots.get(Q.id == snapshot_id)
        
        if not snapshot:
            return False
        
        # Pop the stash
        result = subprocess.run(
            ["git", "stash", "apply", snapshot['stash_ref']],
            cwd=worktree
        )
        
        return result.returncode == 0
    
    def auto_snapshot_wrapper(
        self,
        worktree: str,
        agent_id: str,
        operation: str,
        func: Callable
    ) -> Any:
        """Wrap a function with automatic snapshotting."""
        snapshot_id = self.snapshot(worktree, agent_id, f"before:{operation}")
        
        try:
            return func()
        except Exception as e:
            if snapshot_id:
                print(f"Operation failed. Snapshot available: {snapshot_id}")
            raise
```

#### Integration with Operations

```python
# In MultiAgentRepoTracker:

def rebase_onto_stream_safe(
    self,
    source_stream: str,
    target_stream: str,
    agent_id: str,
    worktree: str
) -> RebaseResult:
    """Rebase with automatic working copy protection."""
    
    def do_rebase():
        return self.rebase_onto_stream(
            source_stream, target_stream, agent_id, worktree
        )
    
    return self.wc_snapshots.auto_snapshot_wrapper(
        worktree, agent_id, "rebase", do_rebase
    )
```

---

### 7.6 Gap Summary

| Gap | Mitigation | Remaining Limitation |
|-----|------------|---------------------|
| Lock-free concurrency | SQLite WAL + parallel streams model | No same-stream concurrent writes (by design) |
| Stable change IDs | Commit message trailers + tracking table | Squash/split require manual recording |
| First-class conflicts | Conflict deferral mode | Markers visible in files |
| Complex cascade rebase | Dependency graph + topological sort | Diamonds restricted, graceful fallback |
| WC snapshots | Auto-snapshot wrapper | Must opt-in per operation |
| jj compatibility | VCSBackend abstraction | Deferred features (lock-free, native conflicts) |

---

## 8. Error Handling

### 7.1 Git Operation Failures

```python
class GitOperationError(Exception):
    """Base class for git operation failures"""
    pass

class ConflictError(GitOperationError):
    """Merge/rebase conflict occurred"""
    def __init__(self, conflicted_files: list[str], operation: str):
        self.conflicted_files = conflicted_files
        self.operation = operation

class BranchNotFoundError(GitOperationError):
    """Referenced branch does not exist"""
    pass

class WorktreeError(GitOperationError):
    """Worktree operation failed"""
    pass
```

### 7.2 Recovery Strategies

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Rebase conflict | Non-zero exit + conflict markers | Abort rebase, report conflicts, let agent/human resolve |
| Merge conflict | Same as above | Abort merge, report conflicts |
| Corrupted worktree | Git status fails | Delete and recreate worktree |
| DB/Git desync | Stream exists in DB but not git | Recreate branch from recorded base, or mark stream as broken |
| Crashed mid-operation | Operation started but not completed | On restart, check for uncommitted state, rollback or complete |

### 7.3 Conflict Handling Interface

```python
class ConflictHandler(Protocol):
    """Interface for handling merge/rebase conflicts"""
    
    def handle(
        self,
        stream_id: str,
        operation: str,  # "rebase" or "merge"
        conflicted_files: list[str],
        worktree: str
    ) -> ConflictResolution:
        """
        Called when conflict occurs.
        
        Implementation should:
        1. Examine conflicted files
        2. Either resolve conflicts and stage, or decide to abort
        3. Return resolution decision
        """
        ...

@dataclass
class ConflictResolution:
    action: Literal["continue", "abort", "skip"]
    modified_files: list[str] = None  # Files that were resolved
```

---

## 9. Visualization & Queries

### 8.1 Stream Tree Visualization

```
main
├── [a1b2c3d4] feature-auth (agent-1) ● active
│   ├── ○ abc1234 add auth middleware [approved]
│   ├── ◐ def5678 add login endpoint [review]
│   └── ○ 9012fed add logout endpoint [draft]
│   │
│   └── [e5f6g7h8] oauth-extension (agent-2) ● active
│       ├── ○ 111aaa add oauth provider [draft]
│       └── ○ 222bbb add oauth callback [draft]
│
└── [i9j0k1l2] feature-payments (agent-3) ● active
    └── ○ 333ccc add stripe integration [draft]
```

### 8.2 Operation Log Visualization

```
Stream: feature-auth (a1b2c3d4)
Agent: agent-1

○ 2024-01-15 10:30:00 [op-001] commit
│   abc1234 "add auth middleware"
│
○ 2024-01-15 10:35:00 [op-002] commit
│   def5678 "add login endpoint"
│
○ 2024-01-15 11:00:00 [op-003] rebase
│   Rebased onto main (was: abc0000, now: def1111)
│   Stack updated: 2 commits
│
○ 2024-01-15 11:15:00 [op-004] commit
│   9012fed "add logout endpoint"
```

### 8.3 Cross-Stream Dependency View

```
                    main
                      │
         ┌────────────┼────────────┐
         ▼            │            ▼
    feature-auth      │      feature-payments
    (agent-1)         │         (agent-3)
         │            │
         ▼            │
  oauth-extension     │
    (agent-2)         │
         │            │
         └────────────┴──► (planned merge to main)
```

---

## 10. Open Questions & Ambiguities

### 10.1 Stream Ownership & Permissions

**Question**: Can multiple agents write to the same stream?

**Options**:
1. **Single owner**: Only creating agent can write (current assumption)
2. **Explicit handoff**: Ownership can be transferred
3. **Shared streams**: Multiple agents can write (needs concurrency control)
4. **Role-based**: Agents have roles (owner, contributor, reviewer)

**Decision**: ✅ **RESOLVED** - Single owner with explicit handoff. Multiple agents on same issue use **parallel streams that branch and merge** (not shared streams). Coordinator is responsible for ensuring only one agent writes to any given stream. See Section 7.1 for the parallel streams model.

**Implications**:
- Each agent gets their own stream(s)
- Coordinator manages merging parallel work
- No concurrent write conflicts by design

### 10.2 Stack Entry Identity Across Rebases

**Question**: How do we track "the same logical change" across rebases when commit hashes change?

**Options**:
1. **Original commit hash**: Store first commit hash, never changes
2. **Stack position**: "Third commit in stack" (fragile if reordered)
3. **Content hash**: Hash of diff content (expensive to compute)
4. **Explicit ID**: UUID assigned when stack entry created
5. **Commit message trailer**: Gerrit-style Change-Id embedded in commit

**Decision**: ✅ **RESOLVED** - Use **commit message trailers** (Gerrit-style `Change-Id: c-xxxx`) as primary identity, backed by tracking table for history. The trailer survives rebases naturally since git preserves commit messages. See Section 7.2 for implementation.

**Remaining limitation**: Squash and split require explicit recording—auto-detection is unreliable.

### 10.3 Handling Divergent Streams

**Question**: What happens when a stream is rebased while another stream depends on its old state?

**Scenario**:
```
         base_commit
              │
              ▼
    stream-A (old head)────► stream-A (new head, after rebase)
              │
              ▼
        stream-B (based on A's old head)
```

**Options**:
1. **Eager cascade**: Automatically rebase B when A changes
2. **Lazy detection**: Warn when B's base is stale, require manual sync
3. **Snapshot references**: B references specific commit, not "head of A"
4. **Prevent divergence**: Lock dependent streams during rebase

**Decision**: ✅ **RESOLVED** - Eager cascade for linear chains and fan-out (Section 7.4). Uses topological sort to determine order. **Diamond merges are restricted** - the model discourages them, and when detected they are flagged for manual resolution or graceful fallback.

### 10.4 Merge vs Rebase for Integration

**Question**: When merging streams back together, should we create merge commits?

**Context**:
- Stacked diff workflows typically want linear history
- Merge commits preserve "this came from feature X"
- Rebase gives cleaner history but loses provenance

**Options**:
1. **Always squash-merge**: One commit per stream
2. **Always rebase**: Linear history, individual commits preserved
3. **Configurable per-stream**: Owner chooses strategy
4. **Configurable per-integration**: Decided at merge time

**Decision**: Default to rebase for cleaner history. Merge strategy configurable per-operation. Stream metadata can specify preferred strategy.

### 10.5 Review Workflow Integration

**Question**: How does review status affect what operations are allowed?

**Scenarios**:
- Can an agent rebase a stack that has approved entries?
- Can an agent modify a commit that's under review?
- What happens to approval when commit is amended?

**Options**:
1. **Advisory only**: Review status is informational, doesn't block operations
2. **Soft gates**: Warn but allow override
3. **Hard gates**: Block operations on approved commits
4. **Reset on change**: Any modification resets review status to draft

**Decision**: ✅ **RESOLVED** - **Stacked diffs are opt-in per stream** (`enable_stacked_review` field). When enabled:
- Operations on reviewed/approved commits emit warnings (soft gates)
- Amending a commit resets its status to "draft"
- Rebasing preserves status but adds "needs_rereview" flag
- Hard blocks only on "merged" status (immutable)

When disabled, commits are tracked but no review workflow is enforced.

### 10.6 Garbage Collection

**Question**: When do we clean up merged/abandoned streams?

**Considerations**:

- Git branches accumulate (performance impact)
- Operation history grows unbounded
- Worktrees consume disk space
- Need to preserve history for audit

**Decision**: ✅ **RESOLVED** - Archive → gradual delete pipeline with explicit GC calls.

#### GC Pipeline

```
Stream lifecycle:
  active → merged/abandoned → archived → pruned (deleted)
                    ↑              ↑           ↑
              auto-archive    retention    explicit prune
                             period ends
```

#### Configuration

```python
@dataclass
class GCConfig:
    # Automatic archival (on state change)
    auto_archive_on_merge: bool = True
    auto_archive_on_abandon: bool = True

    # Retention
    archive_retention_days: int = 30      # Suggest prune after N days

    # What to clean on prune
    delete_git_branches: bool = True      # Remove stream/* branches
    delete_worktrees: bool = True         # Remove deallocated worktrees
```

#### API

```python
def archive_stream(stream_id: str) -> None:
    """
    Move stream to archived state.

    - Moves to archived_streams table
    - Retains full operation history
    - Git branch kept until prune
    - Called automatically on merge/abandon (if configured)
    """

def prune(older_than_days: int = 30) -> PruneResult:
    """
    Delete archived streams past retention period.

    - Removes from database entirely
    - Deletes git branches (stream/*)
    - Returns count of pruned streams
    """

def gc() -> GCResult:
    """
    Run full garbage collection.

    1. Archive any merged/abandoned streams not yet archived
    2. Prune archived streams past retention
    3. Clean up deallocated worktrees
    4. Return summary of actions taken
    """

def deallocate_worktree(agent_id: str) -> None:
    """
    Explicitly remove an agent's worktree.

    Worktrees are only cleaned up via explicit deallocation.
    """
```

#### What We Keep Forever

- **Operation log**: Full history retained until explicit removal
- **Change history**: All commit mappings preserved

#### Future Enhancement

- Orphaned worktree detection (agent crashed without cleanup)
- Background/scheduled GC option
- Operation log compaction (optional, lossy)

### 10.7 Cross-Agent Communication

**Question**: How do agents know when another agent's work is ready to build upon?

**Current assumption**: External coordinator manages this.

**Options**:
1. **Polling**: Agent periodically checks stream status
2. **Callback/webhook**: Tracker notifies interested agents
3. **Status field**: Streams have "ready_for_dependents" flag
4. **Out of scope**: Coordinator's responsibility

**Decision**: Out of scope for tracker. Coordinator is responsible for:
- Notifying agents when dependencies are ready
- Triggering cascade rebases when needed
- Tracking which agents are waiting on which streams

Tracker provides query APIs: `get_stream_status()`, `get_pending_conflicts()`, `is_stale()`.

### 10.8 Coordinator Contract

**Question**: What guarantees must the coordinator provide?

**Required guarantees** (coordinator must ensure):
1. Only one agent writes to a stream at a time
2. Agent is notified when their stream's parent changes  
3. Agent operations complete before stream is reassigned
4. Crashed agents are detected and their streams released

**Tracker provides** (defensive measures, not guarantees):
1. Stream guards that detect stale/concurrent access
2. Last-write timestamps for staleness detection
3. Operation log for recovery after crashes

**Decision**: Document as formal contract. Tracker trusts coordinator but adds defensive checks.

### 10.9 Conflict Resolution Ownership

**Question**: When a conflict occurs during cascade rebase, who resolves it?

**Options**:
1. **Original stream owner**: Agent who created the stream
2. **Triggering agent**: Agent who initiated the cascade
3. **Any available agent**: First agent to claim it
4. **Human escalation**: Flag for human review

**Decision**: Cascade initiator is responsible for conflicts in their direct action. For dependent streams:
- Attempt automatic resolution first
- If fails, mark stream as "conflict_blocked" 
- Notify owning agent
- Owning agent must resolve before their work can continue

### 10.10 Testing Strategy

**Question**: How do we test this system?

**Challenges**:
- Git operations have side effects
- Worktrees require filesystem
- Race conditions in concurrent tests

**Approach**:
1. **Unit tests**: Mock git operations, test logic
2. **Integration tests**: Real git in temp directories
3. **Scenario tests**: Simulate multi-agent workflows
4. **Property-based tests**: Invariants for rebase/merge
5. **Chaos tests**: Random crashes, verify recovery
6. **Regression tests**: Specific edge cases discovered in production

---

## 11. Implementation Phases

### Phase 1: Core Foundation
- [ ] Stream CRUD operations
- [ ] Basic operation logging
- [ ] Worktree management
- [ ] Simple rollback

### Phase 2: Stack Management
- [ ] Stack entry tracking
- [ ] Rebuild stack after rebase
- [ ] Review status tracking

### Phase 3: Cross-Stream Operations
- [ ] Fork stream
- [ ] Rebase onto stream
- [ ] Sync with parent
- [ ] Dependency graph tracking

### Phase 4: Change Identity Tracking
- [ ] Change tracking table
- [ ] Commit history per change
- [ ] Patch-id based commit mapping after rebase
- [ ] Squash/split recording

### Phase 5: Cascade Rebase
- [ ] Topological sort of dependencies
- [ ] Linear chain cascade
- [ ] Fan-out cascade
- [ ] Merge-diamond detection and warning

### Phase 6: Conflict Handling
- [ ] Conflict detection
- [ ] Conflict handler interface
- [ ] Conflict deferral mode (optional)
- [ ] Abort and recovery

### Phase 7: Safety & Snapshots
- [ ] Stream guards (defensive concurrency)
- [ ] Working copy snapshots
- [ ] Auto-snapshot wrapper for dangerous operations

### Phase 8: Visualization & Queries
- [ ] Stream graph visualization
- [ ] Operation log formatting
- [ ] Change history view
- [ ] Conflict status view

### Phase 9: Hardening
- [ ] Coordinator contract documentation
- [ ] Error recovery procedures
- [ ] Garbage collection
- [ ] Performance optimization

---

## 12. Appendix: Example Scenarios

### Scenario A: Simple Parallel Development

```python
# Two agents work on independent features
tracker = MultiAgentRepoTracker("/repo")

stream_auth = tracker.create_stream("auth", "agent-1")
stream_payments = tracker.create_stream("payments", "agent-2")

# Agents work independently...

# Both merge to main when done
tracker.merge_stream(stream_auth, "main", "agent-1", wt1)
tracker.merge_stream(stream_payments, "main", "agent-2", wt2)
```

### Scenario B: Stacked Feature Development

```python
# Agent builds feature incrementally for review
stream = tracker.create_stream("big-feature", "agent-1")

# Agent makes commits, each one becomes reviewable
commit1 = make_commit("refactor: extract helper")
tracker.add_to_stack(stream, commit1)

commit2 = make_commit("feat: add new endpoint")
tracker.add_to_stack(stream, commit2)

commit3 = make_commit("test: add tests for endpoint")
tracker.add_to_stack(stream, commit3)

# Reviewer approves stack entries one by one
tracker.set_review_status(stack_entry_1, ReviewStatus.APPROVED, "reviewer-1")
```

### Scenario C: Building on Another Agent's Work

```python
# Agent 1 starts a feature
stream_base = tracker.create_stream("api-v2", "agent-1")
# ... makes commits ...

# Agent 2 wants to extend it
stream_extension = tracker.fork_stream(stream_base, "api-v2-graphql", "agent-2")
# ... makes commits ...

# Agent 1 updates base feature
# ... more commits to stream_base ...

# Agent 2 syncs with the updates
tracker.sync_with_parent(stream_extension, "agent-2", wt2)

# Eventually merge extension into base
tracker.merge_stream(stream_extension, stream_base, "agent-1", wt1)

# Then merge base to main
tracker.merge_stream(stream_base, "main", "agent-1", wt1)
```

### Scenario D: Rollback After Bad Direction

```python
# Agent goes down a bad path
stream = tracker.create_stream("experiment", "agent-1")

op1 = tracker.record_operation(stream, "agent-1", "commit", before, after)
op2 = tracker.record_operation(stream, "agent-1", "commit", before, after)
op3 = tracker.record_operation(stream, "agent-1", "commit", before, after)

# Reviewer says: "op2 was a mistake, go back"
tracker.rollback_to_operation(stream, op1, worktree)

# Agent continues from corrected state
op4 = tracker.record_operation(stream, "agent-1", "commit", before, after)
```

---

## 13. Glossary

| Term | Definition |
|------|------------|
| Stream | A logical unit of work, maps to a git branch |
| Operation | A single mutation to repo state, forms audit trail |
| Stack | Ordered commits in a stream for incremental review (opt-in) |
| Worktree | Isolated filesystem checkout for an agent |
| Base commit | The commit a stream branched from |
| Fork point | Same as base commit, emphasizes relationship to parent |
| Cascade rebase | Rebasing all dependent streams after parent changes |
| Stacked diff | A commit intended for individual review as part of a series |
| Change | A logical unit tracked across rebases (stable identity) |
| Change-Id | Gerrit-style commit trailer (`Change-Id: c-xxxx`) providing stable identity |
| Commit trailer | Metadata line at end of commit message (key: value format) |
| Commit history | List of all git commits a change has been (newest first) |
| Dependency graph | DAG of stream fork/merge relationships |
| Topological sort | Ordering streams so parents come before children |
| Stream guard | Defensive check against concurrent writes |
| Conflict deferral | Recording conflicts to resolve later vs blocking |
| Working copy snapshot | Saved state of uncommitted changes |
| Coordinator | External system that assigns agents to streams |
| Coordinator contract | Guarantees the coordinator must provide |
| Diamond dependency | Stream depending on multiple parents (restricted/discouraged) |
| Fan-out | One parent stream with multiple children (fully supported) |
| Patch-id | Hash of a commit's diff, stable across rebases if content unchanged |
| TinyBase | Python database interface using SQLite with WAL mode |
| SQLite WAL | Write-Ahead Logging mode enabling concurrent reads/writes |
| VCSBackend | Abstract interface for git/jj, enables future backend swap |
| Parallel streams | Multiple agents working on same issue via separate streams that merge |