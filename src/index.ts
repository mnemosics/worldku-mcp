// worldku-mcp — Worldku memory MCP server. Streamable HTTP binding, MCP revision
// 2026-07-28 only (stateless: no initialize, no sessions, no SSE — every response
// is a single JSON object; async writes are carried by the Tasks extension).
//
// Endpoint map:
//   POST /mcp                                        — the MCP endpoint
//   GET  /.well-known/oauth-protected-resource       — RFC 9728 PRM (points at the Hub AS)
//   anything else                                    — 404 / 405 per binding rules
import type { Env } from './env';
import {
  intVar,
  SERVER_NAME,
  SERVER_VERSION,
  SUPPORTED_VERSIONS,
  TASKS_EXTENSION,
} from './env';
import {
  errorResponse,
  resultResponse,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  type JsonRpcMessage,
} from './jsonrpc';
import { validateProtocol, clientDeclaredTasks, clientName, type ValidatedRequest } from './protocol';
import { authenticate, isAuthFailure, wwwAuthenticate, type AuthContext } from './auth';
import { bumpUsage, bookUsageAction, type UsageGate, type UsageKind } from './billing';
import { TOOLS, validateArgs, validateMessages } from './tools/defs';
import {
  renderReadResult,
  runOverview,
  runRecall,
  runSearch,
  type MemoryRow,
} from './tools/read';
import {
  mintTask,
  receiptText,
  runSave,
  SourceBusyError,
  sourceIdentityOf,
} from './tools/save';
import { getTask } from './tasks';

const SERVER_INFO_META = {
  'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
};

function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  if (!origin) return {};
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function originForbidden(env: Env, request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false; // CLI clients — no Origin header
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return !allowed.includes(origin);
}

interface ToolOutcome {
  text: string;
  isError?: boolean;
  structured?: Record<string, unknown>;
  task?: { taskId: string; ttlMs: number; statusMessage: string };
}

type ToolFailure = { protocol: 'unknown_tool'; name: string } | { protocol: 'insufficient_scope' };

function toolError(text: string): ToolOutcome {
  return { text, isError: true };
}

function overCapText(kind: UsageKind, gate: UsageGate): string {
  const noun = kind === 'read' ? 'read' : 'save';
  return `Daily ${noun} limit reached (${gate.cap}/${gate.cap}). It resets at ${gate.resetsAt} (UTC). `
    + 'This cap exists to catch runaway automation — if you hit it in normal use, please tell us.';
}

async function execTool(
  env: Env,
  req: ValidatedRequest,
  auth: AuthContext,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<ToolOutcome | ToolFailure> {
  const name = req.params['name'];
  const def = TOOLS.find((t) => t.name === name);
  if (typeof name !== 'string' || !def) {
    return { protocol: 'unknown_tool', name: String(name) };
  }
  const rawArgs = req.params['arguments'];
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? rawArgs : {}) as Record<string, unknown>;
  const argError = validateArgs(def, args);
  if (argError) return toolError(argError.message);

  const kind: UsageKind = def.name === 'memory_save' ? 'write' : 'read';
  const scopeNeeded = kind === 'write' ? 'memory:write' : 'memory:read';
  if (!auth.scopes.has(scopeNeeded)) {
    return { protocol: 'insufficient_scope' };
  }

  // N2 sanity gate first; the charged-0 booking only happens for admitted calls.
  const gate = await bumpUsage(env, auth.userId, kind);
  if (!gate.allowed) return toolError(overCapText(kind, gate));
  await bookUsageAction(env, auth.userId, kind);

  if (def.name === 'memory_overview') {
    const rows = await runOverview(env, auth.userId);
    return {
      text: renderReadResult(rows, gate),
      structured: { memories: rows.map(stripId) },
    };
  }

  if (def.name === 'memory_search') {
    const rows = await runSearch(env, auth.userId, args['query'] as string, args['limit'] as number | undefined);
    return {
      text: renderReadResult(rows, gate),
      structured: { memories: rows.map(stripId) },
    };
  }

  if (def.name === 'memory_recall') {
    const out = await runRecall(env, auth.userId, args as Parameters<typeof runRecall>[2]);
    if ('badCursor' in out) return toolError('Invalid cursor — pass the cursor exactly as returned by a previous memory_recall result.');
    if ('badDate' in out) return toolError(`Argument '${out.badDate}' is not a valid ISO date.`);
    const extra = out.nextCursor ? `More results available. Next cursor: ${out.nextCursor}` : undefined;
    return {
      text: renderReadResult(out.rows, gate, extra),
      structured: { memories: out.rows.map(stripId), nextCursor: out.nextCursor },
    };
  }

  // memory_save
  const messages = validateMessages(args['messages']);
  if (!Array.isArray(messages)) return toolError(messages.message);
  const title = args['title'] as string | undefined;
  const source = sourceIdentityOf(clientName(req.meta));
  let receipt;
  try {
    receipt = await runSave(env, auth.userId, source, title, messages);
  } catch (err) {
    if (err instanceof SourceBusyError) {
      return toolError('The previous save from this tool is still being processed. Wait a minute and try again.');
    }
    throw err;
  }
  const usedLine = `Saves used today: ${gate.used}/${gate.cap}.`;
  const text = receiptText(receipt, messages, usedLine);
  if (receipt.batch_id && clientDeclaredTasks(req.meta)) {
    const { taskId, ttlMs } = await mintTask(env, auth.userId, receipt.batch_id);
    return { text, task: { taskId, ttlMs, statusMessage: text } };
  }
  void waitUntil; // reserved for future fire-and-forget bookkeeping
  return { text, structured: { decision: receipt.decision, received: receipt.received, newCount: receipt.new_count } };
}

function stripId(row: MemoryRow): Record<string, unknown> {
  return {
    content: row.content,
    memoryType: row.memory_type,
    source: row.source_name ?? row.source_key,
    importance: row.importance,
    occurredAt: row.occurred_at,
    recordedAt: row.created_at,
  };
}

async function dispatch(
  env: Env,
  req: ValidatedRequest,
  auth: AuthContext,
  waitUntil: (p: Promise<unknown>) => void,
  cors: Record<string, string>,
): Promise<Response> {
  switch (req.method) {
    case 'server/discover':
      return resultResponse(req.id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } },
        instructions:
          'Worldku memory access. Tools only fire on the user\'s explicit ask: '
          + 'memory_save stores the current conversation, memory_overview/memory_search/memory_recall read memories back.',
        ttlMs: 3_600_000,
        cacheScope: 'public',
        _meta: SERVER_INFO_META,
      }, cors);

    case 'tools/list':
      return resultResponse(req.id, {
        resultType: 'complete',
        tools: TOOLS,
        ttlMs: 3_600_000,
        cacheScope: 'public',
        _meta: SERVER_INFO_META,
      }, cors);

    case 'tools/call': {
      let outcome: ToolOutcome | ToolFailure;
      try {
        outcome = await execTool(env, req, auth, waitUntil);
      } catch (err) {
        // Business/backend failure → tool execution error (models can retry);
        // internal details never leave this worker.
        console.error('[worldku-mcp] tool failure', req.params['name'],
          err instanceof Error ? err.message : String(err));
        outcome = toolError('The Worldku memory service is temporarily unavailable. Please try again shortly.');
      }
      if ('protocol' in outcome) {
        if (outcome.protocol === 'unknown_tool') {
          return errorResponse(req.id, 400, INVALID_PARAMS, `Unknown tool: ${outcome.name}`, undefined, cors);
        }
        return new Response(JSON.stringify({ error: 'insufficient_scope' }), {
          status: 403,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': wwwAuthenticate(env, { status: 403, error: 'insufficient_scope' }),
            ...cors,
          },
        });
      }
      if (outcome.task) {
        // CreateTaskResult — only for clients that declared the tasks extension.
        return resultResponse(req.id, {
          resultType: 'task',
          taskId: outcome.task.taskId,
          status: 'working',
          statusMessage: outcome.task.statusMessage,
          createdAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
          ttlMs: outcome.task.ttlMs,
          pollIntervalMs: 3000,
          _meta: SERVER_INFO_META,
        }, cors);
      }
      return resultResponse(req.id, {
        resultType: 'complete',
        content: [{ type: 'text', text: outcome.text }],
        ...(outcome.structured ? { structuredContent: outcome.structured } : {}),
        isError: outcome.isError === true,
        _meta: SERVER_INFO_META,
      }, cors);
    }

    case 'tasks/get': {
      const taskId = req.params['taskId'];
      if (typeof taskId !== 'string') {
        return errorResponse(req.id, 400, INVALID_PARAMS, 'taskId required', undefined, cors);
      }
      const state = await getTask(env, auth.userId, taskId);
      if (!state) {
        return errorResponse(req.id, 400, INVALID_PARAMS, 'Unknown or expired taskId', undefined, cors);
      }
      return resultResponse(req.id, {
        resultType: 'complete',
        taskId: state.taskId,
        status: state.status,
        ...(state.statusMessage ? { statusMessage: state.statusMessage } : {}),
        createdAt: state.createdAt,
        lastUpdatedAt: state.lastUpdatedAt,
        ttlMs: state.ttlMs,
        pollIntervalMs: state.pollIntervalMs,
        ...(state.result ? { result: state.result } : {}),
        ...(state.error ? { error: state.error } : {}),
        _meta: SERVER_INFO_META,
      }, cors);
    }

    case 'tasks/update':
      // No input_required flows exist in this server — acknowledge with an empty result.
      return resultResponse(req.id, { resultType: 'complete', _meta: SERVER_INFO_META }, cors);

    case 'tasks/cancel':
      // Cooperative: acknowledged, but enqueued extraction is not interrupted
      // (documented in the memory_save tool description).
      return resultResponse(req.id, { resultType: 'complete', _meta: SERVER_INFO_META }, cors);

    default:
      return errorResponse(req.id, 404, METHOD_NOT_FOUND, `Method not found: ${req.method}`, undefined, cors);
  }
}

function prmResponse(env: Env): Response {
  const origin = new URL(env.RESOURCE_URI).origin;
  return new Response(JSON.stringify({
    resource: env.RESOURCE_URI,
    authorization_servers: [env.AUTH_SERVER_URL],
    scopes_supported: ['memory:read', 'memory:write'],
    bearer_methods_supported: ['header'],
    resource_name: 'Worldku Memory MCP',
    resource_documentation: `${origin}/`,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(env, origin);

    if (url.pathname === '/.well-known/oauth-protected-resource') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*' } });
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
      return prmResponse(env);
    }

    if (url.pathname !== '/mcp') {
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // CORS preflight is answered before any auth (an unanswered preflight would
    // block browser clients from ever sending the real request).
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // DNS-rebinding guard: a present-but-unknown Origin is refused outright.
    if (originForbidden(env, request)) {
      return errorResponse(null, 403, INVALID_PARAMS, 'Origin not allowed');
    }

    if (request.method !== 'POST') {
      // Legacy-transport probes (GET SSE stream / DELETE session) land here too.
      return new Response(null, { status: 405, headers: { Allow: 'POST', ...cors } });
    }

    const maxBytes = intVar(env.PAYLOAD_MAX_BYTES, 10_485_760);
    const declaredLen = Number(request.headers.get('content-length') ?? '');
    if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
      return errorResponse(null, 413, INVALID_PARAMS, 'Payload too large', undefined, cors);
    }
    const raw = await request.text();
    if (raw.length > maxBytes) {
      return errorResponse(null, 413, INVALID_PARAMS, 'Payload too large', undefined, cors);
    }

    let body: JsonRpcMessage;
    try {
      body = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return errorResponse(null, 400, PARSE_ERROR, 'Parse error', undefined, cors);
    }

    // Notifications (no id): accepted with 202 and no body.
    if (body.id === undefined && typeof body.method === 'string') {
      return new Response(null, { status: 202, headers: cors });
    }

    const validated = validateProtocol(request, body);
    if ('status' in validated) {
      const id = typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null;
      return errorResponse(id, validated.status, validated.code, validated.message, validated.data, cors);
    }

    const auth = await authenticate(env, request, (p) => ctx.waitUntil(p));
    if (isAuthFailure(auth)) {
      return new Response(JSON.stringify({ error: auth.error }), {
        status: auth.status,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': wwwAuthenticate(env, auth),
          ...cors,
        },
      });
    }

    try {
      return await dispatch(env, validated, auth, (p) => ctx.waitUntil(p), cors);
    } catch (err) {
      // Sanitized: internal error details (provider bodies, stacks) never leave.
      console.error('[worldku-mcp] internal error', validated.method,
        err instanceof Error ? err.message : String(err));
      return errorResponse(validated.id, 500, INTERNAL_ERROR, 'Internal error', undefined, cors);
    }
  },
};

export default worker;
