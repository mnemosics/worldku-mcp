// Test seams: a fake Supabase (fetch-level router over the PostgREST paths the
// worker uses) + request builders that produce protocol-correct POSTs.
import { vi } from 'vitest';
import type { Env } from './env';
import { sha256Hex } from './hash';

export const TEST_KEY = 'wk_mcp_testkey_0123456789abcdef';
export const TEST_USER = '11111111-1111-1111-1111-111111111111';

export interface FakeDb {
  keyRows: Array<{ id: string; user_id: string; key_hash: string; revoked_at: string | null }>;
  tokenRows: Array<{
    user_id: string; token_hash: string; scope: string; audience: string;
    expires_at: string; revoked_at: string | null;
  }>;
  taskRows: Array<{ task_id: string; user_id: string; batch_id: string; created_at: string; expires_at: string }>;
  batchRows: Array<{ id: string; status: string; stats: Record<string, unknown> | null; error: string | null; created_at: string; finished_at: string | null }>;
  bumpResult: { allowed: boolean; used: number; resets_at: string };
  /** 55007 memory_consent_off from the usage counter / the work RPCs. */
  bumpConsentOff: boolean;
  listConsentOff: boolean;
  recallLogFail: boolean;
  /** What the DB's memory_current_extractor_version() returns — deliberately not
   *  a real platform label: the worker must forward whatever the DB says. */
  extractorVersion: unknown;
  extractorVersionFail: boolean;
  saveReceipt: Record<string, unknown>;
  listRows: unknown[];
  searchRows: unknown[];
  calls: Array<{ kind: string; path: string; body: unknown }>;
  insertedTasks: Array<Record<string, unknown>>;
}

export function makeFakeDb(): FakeDb {
  return {
    keyRows: [],
    tokenRows: [],
    taskRows: [],
    batchRows: [],
    bumpResult: { allowed: true, used: 1, resets_at: '2026-07-30T00:00:00+00:00' },
    bumpConsentOff: false,
    listConsentOff: false,
    recallLogFail: false,
    extractorVersion: 'mem-3type@db-fixture',
    extractorVersionFail: false,
    saveReceipt: { decision: 'new', received: 2, new_count: 2, total_messages: 2, batch_id: 'b-1' },
    listRows: [],
    searchRows: [],
    calls: [],
    insertedTasks: [],
  };
}

export async function seedKey(db: FakeDb, key = TEST_KEY, userId = TEST_USER): Promise<void> {
  db.keyRows.push({ id: 'k-1', user_id: userId, key_hash: await sha256Hex(key), revoked_at: null });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Install a fetch mock that plays the Supabase REST surface. Returns a restore fn. */
export function installFetchMock(db: FakeDb): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const path = new URL(url).pathname + new URL(url).search;
    db.calls.push({ kind: method, path, body });

    if (path.startsWith('/rest/v1/rpc/memory_mcp_bump_usage')) {
      if (db.bumpConsentOff) return json({ code: '55007', message: 'memory_consent_off' }, 400);
      return json(db.bumpResult);
    }
    if (path.startsWith('/rest/v1/rpc/spend_credits_by_amount')) return json({ txn_id: 't', cost: 0 });
    if (path.startsWith('/rest/v1/rpc/memory_log_recall')) {
      if (db.recallLogFail) return json({ message: 'recall log unavailable' }, 500);
      return json(null);
    }
    if (path.startsWith('/rest/v1/rpc/memory_current_extractor_version')) {
      if (db.extractorVersionFail) return json({ message: 'db unavailable' }, 503);
      return json(db.extractorVersion);
    }
    if (path.startsWith('/rest/v1/rpc/memory_mcp_save_conversation')) {
      if (db.saveReceipt['__error'] === 'busy') {
        return json({ code: '55006', message: 'mcp_source_busy' }, 400);
      }
      return json(db.saveReceipt);
    }
    if (path.startsWith('/rest/v1/rpc/memory_mcp_list')) {
      if (db.listConsentOff) return json({ code: '55007', message: 'memory_consent_off' }, 400);
      return json(db.listRows);
    }
    if (path.startsWith('/rest/v1/rpc/memory_mcp_search')) return json(db.searchRows);
    if (path.startsWith('/rest/v1/mcp_access_keys')) {
      if (method === 'PATCH') return new Response(null, { status: 204 });
      const hashMatch = /key_hash=eq\.([0-9a-f]+)/.exec(path);
      return json(db.keyRows.filter((r) => r.key_hash === hashMatch?.[1] && r.revoked_at === null));
    }
    if (path.startsWith('/rest/v1/oauth_tokens')) {
      const hashMatch = /token_hash=eq\.([0-9a-f]+)/.exec(path);
      return json(db.tokenRows.filter((r) => r.token_hash === hashMatch?.[1] && r.revoked_at === null));
    }
    if (path.startsWith('/rest/v1/mcp_tasks')) {
      if (method === 'POST') {
        db.insertedTasks.push(body as Record<string, unknown>);
        return new Response(null, { status: 201 });
      }
      const idMatch = /task_id=eq\.([^&]+)/.exec(path);
      const userMatch = /user_id=eq\.([^&]+)/.exec(path);
      const id = decodeURIComponent(idMatch?.[1] ?? '');
      return json(db.taskRows.filter(
        (r) => r.task_id === id && (!userMatch || r.user_id === userMatch[1]),
      ));
    }
    if (path.startsWith('/rest/v1/import_batches')) {
      const idMatch = /id=eq\.([^&]+)/.exec(path);
      return json(db.batchRows.filter((r) => r.id === idMatch?.[1]));
    }
    return json({ message: `unmocked path ${path}` }, 500);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GATEWAY: {
      fetch: vi.fn(async () => json({ embeddings: [[0.1, 0.2, 0.3]], dimensions: 3, tokensUsed: 1 })),
    } as unknown as Fetcher,
    SUPABASE_URL: 'https://sb.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    MCP_APP_KEY: 'app-key-test',
    MCP_APP_ID: 'app_worldku_mcp',
    MCP_SCENE_ID: 'scene_platform_mcp',
    BILLING_APP_ID: 'app_worldku',
    RESOURCE_URI: 'https://mcp.worldku.com/mcp',
    AUTH_SERVER_URL: 'https://www.worldku.com',
    ALLOWED_ORIGINS: 'https://claude.ai',
    ...overrides,
  };
}

export function makeCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

export interface McpRequestOptions {
  method?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  params?: Record<string, unknown>;
  token?: string | null;
  headers?: Record<string, string | null>;
  meta?: Record<string, unknown> | null;
  declareTasks?: boolean;
  clientName?: string;
  id?: string | number;
  origin?: string;
}

export function mcpRequest(opts: McpRequestOptions = {}): Request {
  const method = opts.method ?? 'tools/call';
  const meta: Record<string, unknown> = opts.meta === null ? {} : {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': opts.declareTasks
      ? { extensions: { 'io.modelcontextprotocol/tasks': {} } }
      : {},
    'io.modelcontextprotocol/clientInfo': { name: opts.clientName ?? 'Claude Code', version: '1.0.0' },
    ...(opts.meta ?? {}),
  };
  const params: Record<string, unknown> = {
    _meta: meta,
    ...(method === 'tools/call'
      ? { name: opts.toolName ?? 'memory_overview', arguments: opts.args ?? {} }
      : {}),
    ...(opts.params ?? {}),
  };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': method,
  };
  if (method === 'tools/call') headers['Mcp-Name'] = (opts.toolName ?? 'memory_overview');
  if (opts.token !== null) headers['Authorization'] = `Bearer ${opts.token ?? TEST_KEY}`;
  if (opts.origin) headers['Origin'] = opts.origin;
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  return new Request('https://mcp.worldku.com/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: opts.id ?? 1, method, params }),
  });
}

export async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}
