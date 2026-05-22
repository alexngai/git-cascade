/**
 * Smoke tests for the cascade RPC schemas (diff-rpc + action-rpc).
 *
 * Mirrors the `CascadeCapability` block at the bottom of `events.test.ts`:
 * the point is compile-time + export-presence verification, not runtime
 * behavior. We construct a typed value for every published param interface
 * and assert that the method constants are non-empty strings with the right
 * prefix.
 */

import { describe, it, expect } from 'vitest';
import {
  // ── diff RPC ──────────────────────────────────────────────────────────────
  CASCADE_DIFF_METHODS,
  CASCADE_DIFF_METHOD_SET,
  DIFF_INLINE_THRESHOLD_BYTES,
  DIFF_CHUNK_SIZE_BYTES,
  DIFF_REQUEST_TIMEOUT_MS,
  DIFF_MAX_RAW_BYTES,
  isErrorResponse,
  isInlineResponse,
  isStreamingResponse,
  type CascadeDiffMethod,
  type CascadeDiffRequestParams,
  type CascadeDiffInlineResponse,
  type CascadeDiffStreamingResponse,
  type CascadeDiffErrorResponse,
  type CascadeDiffResponseParams,
  type CascadeDiffChunkParams,
  type CascadeDiffMethodMap,
  type DiffPayload,
  type DiffError,
  type DiffErrorCode,
  type DiffResult,

  // ── action RPC ────────────────────────────────────────────────────────────
  CASCADE_ACTION_METHODS,
  CASCADE_ACTION_METHOD_SET,
  type CascadeAction,
  type CascadeActionMethod,
  type CascadeActionMergeParams,
  type CascadeActionAbandonParams,
  type CascadeActionPauseParams,
  type CascadeActionResumeParams,
  type CascadeActionResolveParams,
  type CascadeActionPushParams,
  type CascadeActionCommitParams,
  type CascadeActionParams,
  type CascadeActionParamsMap,
  type CascadeActionMethodMap,
} from '../src/index.js';

describe('CASCADE_DIFF_METHODS', () => {
  it('exports the three wire methods under the cascade/diff. prefix', () => {
    expect(CASCADE_DIFF_METHODS.REQUEST).toBe('cascade/diff.request');
    expect(CASCADE_DIFF_METHODS.RESPONSE).toBe('cascade/diff.response');
    expect(CASCADE_DIFF_METHODS.CHUNK).toBe('cascade/diff.chunk');
  });

  it('every method is a non-empty string starting with cascade/diff.', () => {
    for (const method of Object.values(CASCADE_DIFF_METHODS)) {
      expect(typeof method).toBe('string');
      expect(method.length).toBeGreaterThan(0);
      expect(method.startsWith('cascade/diff.')).toBe(true);
    }
  });

  it('CASCADE_DIFF_METHOD_SET contains every method value', () => {
    for (const method of Object.values(CASCADE_DIFF_METHODS)) {
      expect(CASCADE_DIFF_METHOD_SET.has(method)).toBe(true);
    }
    expect(CASCADE_DIFF_METHOD_SET.size).toBe(
      Object.keys(CASCADE_DIFF_METHODS).length,
    );
  });

  it('CascadeDiffMethod narrows to one of the published methods', () => {
    const m: CascadeDiffMethod = CASCADE_DIFF_METHODS.REQUEST;
    expect(m).toBe('cascade/diff.request');
  });
});

describe('diff-rpc tuning constants', () => {
  it('exports positive integers for every tuning constant', () => {
    expect(DIFF_INLINE_THRESHOLD_BYTES).toBeGreaterThan(0);
    expect(DIFF_CHUNK_SIZE_BYTES).toBeGreaterThan(0);
    expect(DIFF_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DIFF_MAX_RAW_BYTES).toBeGreaterThan(0);
  });
});

describe('CascadeDiff* param shapes', () => {
  it('accepts a minimal CascadeDiffRequestParams', () => {
    const params: CascadeDiffRequestParams = {
      request_id: 'req-1',
      stream_id: 's-1',
      head: 'abc123',
      format: 'unified',
    };
    expect(params.request_id).toBe('req-1');
    expect(params.format).toBe('unified');
  });

  it('accepts a full CascadeDiffRequestParams (base + file_paths + files_only)', () => {
    const params: CascadeDiffRequestParams = {
      request_id: 'req-2',
      stream_id: 's-2',
      head: 'def456',
      base: 'aaa111',
      file_paths: ['src/a.ts', 'src/b.ts'],
      files_only: true,
      format: 'unified',
    };
    expect(params.file_paths).toHaveLength(2);
    expect(params.files_only).toBe(true);
  });

  it('accepts CascadeDiffInlineResponse and isInlineResponse narrows it', () => {
    const inline: CascadeDiffInlineResponse = {
      request_id: 'req-1',
      files_touched: ['src/a.ts'],
      streaming: false,
      diff: 'diff --git a/src/a.ts b/src/a.ts\n...',
      truncated: false,
    };
    const r: CascadeDiffResponseParams = inline;
    expect(isInlineResponse(r)).toBe(true);
    expect(isStreamingResponse(r)).toBe(false);
    expect(isErrorResponse(r)).toBe(false);
  });

  it('accepts CascadeDiffStreamingResponse and isStreamingResponse narrows it', () => {
    const streaming: CascadeDiffStreamingResponse = {
      request_id: 'req-2',
      files_touched: ['src/big.ts'],
      streaming: true,
      chunk_stream_id: 'cs-1',
      total_size: 1024 * 1024 * 5,
    };
    const r: CascadeDiffResponseParams = streaming;
    expect(isStreamingResponse(r)).toBe(true);
    expect(isInlineResponse(r)).toBe(false);
    expect(isErrorResponse(r)).toBe(false);
  });

  it('accepts CascadeDiffErrorResponse and isErrorResponse narrows it', () => {
    const err: CascadeDiffErrorResponse = {
      request_id: 'req-3',
      error: { code: 'not_found', message: 'stream gone' },
    };
    const r: CascadeDiffResponseParams = err;
    expect(isErrorResponse(r)).toBe(true);
    expect(isInlineResponse(r)).toBe(false);
    expect(isStreamingResponse(r)).toBe(false);
  });

  it('accepts a CascadeDiffChunkParams with the final-chunk fields', () => {
    const chunk: CascadeDiffChunkParams = {
      chunk_stream_id: 'cs-1',
      seq: 4,
      data: 'YmFzZTY0',
      final: true,
      sha256: 'a'.repeat(64),
      truncated: false,
    };
    expect(chunk.final).toBe(true);
    expect(chunk.sha256).toHaveLength(64);
  });

  it('CascadeDiffMethodMap can key on each method literal', () => {
    type Req = CascadeDiffMethodMap['cascade/diff.request'];
    type Res = CascadeDiffMethodMap['cascade/diff.response'];
    type Chk = CascadeDiffMethodMap['cascade/diff.chunk'];
    const req: Req = {
      request_id: 'r',
      stream_id: 's',
      head: 'h',
      format: 'unified',
    };
    const res: Res = {
      request_id: 'r',
      files_touched: [],
      streaming: false,
      diff: '',
      truncated: false,
    };
    const chk: Chk = { chunk_stream_id: 'cs', seq: 0, data: '' };
    expect(req.format).toBe('unified');
    expect((res as CascadeDiffInlineResponse).streaming).toBe(false);
    expect(chk.seq).toBe(0);
  });
});

describe('DiffResult helper shapes', () => {
  it('accepts a success DiffResult with a DiffPayload', () => {
    const payload: DiffPayload = {
      diff: 'diff text',
      files_touched: ['a.ts'],
      truncated: false,
    };
    const ok: DiffResult = { ok: true, payload };
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.payload.diff).toBe('diff text');
    }
  });

  it('accepts a failure DiffResult with every DiffErrorCode', () => {
    const codes: DiffErrorCode[] = [
      'swarm_offline',
      'capability_missing',
      'timeout',
      'integrity_failed',
      'not_found',
      'bad_request',
      'internal',
    ];
    for (const code of codes) {
      const err: DiffError = { code, message: `err: ${code}` };
      const result: DiffResult = { ok: false, error: err };
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(code);
      }
    }
  });
});

describe('CASCADE_ACTION_METHODS', () => {
  it('exports a method for every CascadeAction under x-cascade/request.', () => {
    const actions: CascadeAction[] = [
      'merge',
      'abandon',
      'pause',
      'resume',
      'resolve',
      'push',
      'commit',
    ];
    for (const a of actions) {
      const method = CASCADE_ACTION_METHODS[a];
      expect(typeof method).toBe('string');
      expect(method.length).toBeGreaterThan(0);
      expect(method.startsWith('x-cascade/request.')).toBe(true);
      expect(method.endsWith(a)).toBe(true);
    }
  });

  it('CASCADE_ACTION_METHOD_SET contains every method value', () => {
    for (const method of Object.values(CASCADE_ACTION_METHODS)) {
      expect(CASCADE_ACTION_METHOD_SET.has(method)).toBe(true);
    }
    expect(CASCADE_ACTION_METHOD_SET.size).toBe(
      Object.keys(CASCADE_ACTION_METHODS).length,
    );
  });

  it('CascadeActionMethod narrows to one of the published method strings', () => {
    const m: CascadeActionMethod = CASCADE_ACTION_METHODS.merge;
    expect(m).toBe('x-cascade/request.merge');
  });
});

describe('CascadeAction* param shapes', () => {
  it('accepts CascadeActionMergeParams with optional target + metadata', () => {
    const merge: CascadeActionMergeParams = {
      stream_id: 's-1',
      target_stream_id: 'main',
      metadata: { task_ref: { resource_id: 'r', node_id: 'n' } },
    };
    expect(merge.stream_id).toBe('s-1');
    expect(merge.target_stream_id).toBe('main');
  });

  it('accepts a bare-minimum CascadeActionMergeParams (just stream_id)', () => {
    const merge: CascadeActionMergeParams = { stream_id: 's-2' };
    expect(merge.stream_id).toBe('s-2');
  });

  it('accepts CascadeActionAbandonParams with a reason', () => {
    const abandon: CascadeActionAbandonParams = {
      stream_id: 's-3',
      reason: 'superseded',
    };
    expect(abandon.reason).toBe('superseded');
  });

  it('accepts CascadeActionPauseParams with a reason', () => {
    const pause: CascadeActionPauseParams = {
      stream_id: 's-4',
      reason: 'awaiting review',
    };
    expect(pause.reason).toBe('awaiting review');
  });

  it('accepts a CascadeActionResumeParams (no optional fields exercised)', () => {
    const resume: CascadeActionResumeParams = { stream_id: 's-5' };
    expect(resume.stream_id).toBe('s-5');
  });

  it('accepts CascadeActionResolveParams with conflict_id + strategy', () => {
    const resolve: CascadeActionResolveParams = {
      stream_id: 's-6',
      conflict_id: 'cf-abcdef12',
      strategy: 'ours',
    };
    expect(resolve.conflict_id).toBe('cf-abcdef12');
    expect(resolve.strategy).toBe('ours');
  });

  it('accepts CascadeActionPushParams with remote + target_ref', () => {
    const push: CascadeActionPushParams = {
      stream_id: 's-7',
      remote: 'origin',
      target_ref: 'refs/heads/main',
    };
    expect(push.remote).toBe('origin');
    expect(push.target_ref).toBe('refs/heads/main');
  });

  it('accepts CascadeActionCommitParams with message + metadata', () => {
    const commit: CascadeActionCommitParams = {
      stream_id: 's-8',
      message: 'feat: thing',
      metadata: { task_ref: { resource_id: 'r', node_id: 'n' } },
    };
    expect(commit.message).toBe('feat: thing');
  });

  it('CascadeActionParams union accepts every concrete param shape', () => {
    const variants: CascadeActionParams[] = [
      { stream_id: 's', target_stream_id: 'main' },
      { stream_id: 's', reason: 'r' },
      { stream_id: 's' },
      { stream_id: 's', conflict_id: 'cf-1', strategy: 'ours' },
      { stream_id: 's', remote: 'origin' },
      { stream_id: 's', message: 'm' },
    ];
    expect(variants).toHaveLength(6);
  });

  it('CascadeActionParamsMap keys cleanly on the bare action name', () => {
    type MergeParams = CascadeActionParamsMap['merge'];
    type AbandonParams = CascadeActionParamsMap['abandon'];
    const m: MergeParams = { stream_id: 's' };
    const a: AbandonParams = { stream_id: 's', reason: 'x' };
    expect(m.stream_id).toBe('s');
    expect(a.reason).toBe('x');
  });

  it('CascadeActionMethodMap keys on the full method string', () => {
    type MergeParams = CascadeActionMethodMap['x-cascade/request.merge'];
    type PauseParams = CascadeActionMethodMap['x-cascade/request.pause'];
    const m: MergeParams = { stream_id: 's' };
    const p: PauseParams = { stream_id: 's', reason: 'r' };
    expect(m.stream_id).toBe('s');
    expect(p.reason).toBe('r');
  });
});
