// worldku-mcp — Worldku memory MCP server. Streamable HTTP binding, dual-era:
// native MCP revision 2026-07-28 (stateless: no sessions, no SSE — every response
// is a single JSON object; async writes carried by the Tasks extension) plus the
// 2025-era initialize-handshake leg for current-generation clients (src/legacy.ts).
// The era is selected per request from the MCP-Protocol-Version header / method,
// exactly as the 2026-07-28 versioning spec describes for dual-era servers.
//
// Endpoint map:
//   POST /mcp                                        — the MCP endpoint
//   GET  /.well-known/oauth-protected-resource[/mcp] — RFC 9728 PRM (points at the Hub AS)
//   anything else                                    — 404 / 405 per binding rules
import type { Env } from './env';
import {
  intVar,
  PROTOCOL_VERSION,
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
  type JsonRpcId,
  type JsonRpcMessage,
} from './jsonrpc';
import { validateProtocol, clientDeclaredTasks, clientName, type ValidatedRequest } from './protocol';
import { dispatchLegacy } from './legacy';
import { authenticate, isAuthFailure, wwwAuthenticate, type AuthContext } from './auth';
import { bumpUsage, bookUsageAction, type UsageGate, type UsageKind } from './billing';
import { TOOLS, validateArgs, validateMessages } from './tools/defs';
import { ConsentOffError } from './db';
import {
  logRecall,
  parseRecallArgs,
  renderReadResult,
  runOverview,
  runRecall,
  runSearch,
  UNTRUSTED_NOTICE,
  type MemoryRow,
  type RecallArgs,
  type RecallQuery,
} from './tools/read';
import {
  mintTask,
  receiptText,
  runSave,
  SourceBusyError,
  sourceIdentityOf,
} from './tools/save';
import { getTask } from './tasks';
import { SERVER_CARD_PATH, AI_CATALOG_PATH, serverCardResponse, aiCatalogResponse } from './server-card';

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

// The memory consent switch is off (ERRCODE 55007, raised by the usage counter
// before anything is booked, and by the work RPCs as defense in depth). A normal
// tool result, not an error: the client AI is meant to read this and relay it.
// Bare URL on purpose — the next-intl middleware 307s to the user's locale.
const CONSENT_OFF_TEXT =
  'Memory is turned off for this Worldku account, so nothing can be read or saved right now.\n'
  + 'The user can turn it back on at https://worldku.com/settings (Memory switch).';

interface ToolCallContext {
  clientName: string | undefined;
  tasksDeclared: boolean;
  waitUntil: (p: Promise<unknown>) => void;
}

async function execTool(
  env: Env,
  params: Record<string, unknown>,
  auth: AuthContext,
  call: ToolCallContext,
): Promise<ToolOutcome | ToolFailure> {
  const name = params['name'];
  const def = TOOLS.find((t) => t.name === name);
  if (typeof name !== 'string' || !def) {
    return { protocol: 'unknown_tool', name: String(name) };
  }
  const rawArgs = params['arguments'];
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? rawArgs : {}) as Record<string, unknown>;
  const argError = validateArgs(def, args);
  if (argError) return toolError(argError.message);

  // The per-tool argument parsing below is pure, and it runs BEFORE the usage
  // gate: a malformed cursor, date or transcript is the caller's typo, and a
  // typo must never cost the user a read or a save.
  let recall: RecallQuery | undefined;
  let messages: { role: string; content: string }[] | undefined;
  if (def.name === 'memory_recall') {
    const parsed = parseRecallArgs(args as RecallArgs);
    if ('badCursor' in parsed) {
      return toolError('Invalid cursor — pass the cursor exactly as returned by a previous memory_recall result.');
    }
    if ('badDate' in parsed) return toolError(`Argument '${parsed.badDate}' is not a valid ISO date.`);
    recall = parsed;
  } else if (def.name === 'memory_save') {
    const parsed = validateMessages(args['messages']);
    if (!Array.isArray(parsed)) return toolError(parsed.message);
    messages = parsed;
  }

  const kind: UsageKind = def.name === 'memory_save' ? 'write' : 'read';
  const scopeNeeded = kind === 'write' ? 'memory:write' : 'memory:read';
  if (!auth.scopes.has(scopeNeeded)) {
    return { protocol: 'insufficient_scope' };
  }

  // N2 sanity gate first; the charged-0 booking only happens for admitted calls.
  const gate = await bumpUsage(env, auth.userId, kind);
  if (!gate.allowed) return toolError(overCapText(kind, gate));
  await bookUsageAction(env, auth.userId, kind);

  const source = sourceIdentityOf(call.clientName);

  if (def.name === 'memory_overview') {
    const rows = await runOverview(env, auth.userId);
    logRecall(env, auth.userId, source.key, rows, call.waitUntil);
    return {
      text: renderReadResult(rows, gate),
      structured: { notice: UNTRUSTED_NOTICE, memories: rows.map(stripId) },
    };
  }

  if (def.name === 'memory_search') {
    const rows = await runSearch(env, auth.userId, args['query'] as string, args['limit'] as number | undefined);
    logRecall(env, auth.userId, source.key, rows, call.waitUntil);
    return {
      text: renderReadResult(rows, gate),
      structured: { notice: UNTRUSTED_NOTICE, memories: rows.map(stripId) },
    };
  }

  if (recall) {
    const out = await runRecall(env, auth.userId, recall);
    logRecall(env, auth.userId, source.key, out.rows, call.waitUntil);
    const extra = out.nextCursor ? `More results available. Next cursor: ${out.nextCursor}` : undefined;
    return {
      text: renderReadResult(out.rows, gate, extra),
      structured: { notice: UNTRUSTED_NOTICE, memories: out.rows.map(stripId), nextCursor: out.nextCursor },
    };
  }

  if (messages) {
    const title = args['title'] as string | undefined;
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
    if (receipt.batch_id && call.tasksDeclared) {
      const { taskId, ttlMs } = await mintTask(env, auth.userId, receipt.batch_id);
      return { text, task: { taskId, ttlMs, statusMessage: text } };
    }
    return { text, structured: { decision: receipt.decision, received: receipt.received, newCount: receipt.new_count } };
  }

  // Exhaustiveness guard: TOOLS is fixed and every entry is handled above. A new
  // tool added without a branch must fail loudly here rather than book silently.
  throw new Error(`unhandled tool: ${def.name}`);
}

/** Shared tools/call response builder (both protocol eras; the task shape can
 *  only occur when the caller declared the tasks extension). */
async function runToolCall(
  env: Env,
  id: JsonRpcId,
  params: Record<string, unknown>,
  auth: AuthContext,
  call: ToolCallContext,
  cors: Record<string, string>,
): Promise<Response> {
  let outcome: ToolOutcome | ToolFailure;
  try {
    outcome = await execTool(env, params, auth, call);
  } catch (err) {
    if (err instanceof ConsentOffError) {
      // Consent switch off (55007) — a normal outcome for the client AI to relay,
      // NOT an error, and caught before the generic catch below would mislabel
      // it as an outage. Both the usage counter and the work RPCs land here.
      outcome = { text: CONSENT_OFF_TEXT };
    } else {
      // Business/backend failure → tool execution error (models can retry);
      // internal details never leave this worker.
      console.error('[worldku-mcp] tool failure', params['name'],
        err instanceof Error ? err.message : String(err));
      outcome = toolError('The Worldku memory service is temporarily unavailable. Please try again shortly.');
    }
  }
  if ('protocol' in outcome) {
    if (outcome.protocol === 'unknown_tool') {
      return errorResponse(id, 400, INVALID_PARAMS, `Unknown tool: ${outcome.name}`, undefined, cors);
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
    return resultResponse(id, {
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
  return resultResponse(id, {
    resultType: 'complete',
    content: [{ type: 'text', text: outcome.text }],
    ...(outcome.structured ? { structuredContent: outcome.structured } : {}),
    isError: outcome.isError === true,
    _meta: SERVER_INFO_META,
  }, cors);
}

function stripId(row: MemoryRow): Record<string, unknown> {
  return {
    content: row.content,
    memoryType: row.memory_type,
    source: row.source_name ?? row.source_key,
    importance: row.importance,
    occurredAt: row.occurred_at,
    recordedAt: row.created_at,
    // Per-object trust marker: structuredContent has no text frame, so every
    // memory carries the boundary itself (the container carries the prose).
    untrusted: true,
  };
}

async function dispatch(
  env: Env,
  req: ValidatedRequest,
  auth: AuthContext,
  cors: Record<string, string>,
  waitUntil: (p: Promise<unknown>) => void,
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

    case 'tools/call':
      return runToolCall(env, req.id, req.params, auth, {
        clientName: clientName(req.meta),
        tasksDeclared: clientDeclaredTasks(req.meta),
        waitUntil,
      }, cors);

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

    // Neither method changes server state — tasks/update has no input_required
    // flow to answer, and cancellation is cooperative (enqueued extraction is not
    // interrupted, as the memory_save description says). They still resolve the
    // task first: acknowledging an id that does not exist, or belongs to someone
    // else, would confirm it to anyone holding a credential.
    case 'tasks/update':
    case 'tasks/cancel': {
      const taskId = req.params['taskId'];
      if (typeof taskId !== 'string') {
        return errorResponse(req.id, 400, INVALID_PARAMS, 'taskId required', undefined, cors);
      }
      if (!(await getTask(env, auth.userId, taskId))) {
        return errorResponse(req.id, 400, INVALID_PARAMS, 'Unknown or expired taskId', undefined, cors);
      }
      return resultResponse(req.id, { resultType: 'complete', _meta: SERVER_INFO_META }, cors);
    }

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
    // EXTRACTOR_VERSION feeds segment-job idempotency keys shared with the import
    // worker; a silent fallback already forked those keys once (mem-3type@1 vs @2).
    // Workers have no boot phase, so "refuse to start" lives at the request entry.
    if (!env.EXTRACTOR_VERSION) {
      console.error('[worldku-mcp] EXTRACTOR_VERSION is not set — refusing to serve');
      return errorResponse(null, 500, INTERNAL_ERROR,
        'Server misconfigured: the EXTRACTOR_VERSION environment variable is not set.');
    }
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(env, origin);

    // RFC 9728 PRM: both the origin-level path and the path-suffixed variant
    // (/.well-known/oauth-protected-resource/mcp) that clients derive from a
    // resource URI with a path component.
    if (url.pathname === '/.well-known/oauth-protected-resource'
        || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*' } });
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
      return prmResponse(env);
    }

    // Server Card discovery (SEP-2127 experimental extension): the card at the
    // extension's reserved location + the domain-level AI Catalog entry point.
    if (url.pathname === SERVER_CARD_PATH || url.pathname === AI_CATALOG_PATH) {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*' } });
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
      return url.pathname === SERVER_CARD_PATH ? serverCardResponse(env) : aiCatalogResponse(env);
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

    // Content-Length is advisory — absent on chunked bodies, and NaN if garbage,
    // in which case both comparisons below are false and we fall through to the
    // authoritative check. That one measures BYTES: a string length would count
    // UTF-16 code units and let a multi-byte payload past a byte cap.
    const maxBytes = intVar(env.PAYLOAD_MAX_BYTES, 10_485_760);
    if (Number(request.headers.get('content-length')) > maxBytes) {
      return errorResponse(null, 413, INVALID_PARAMS, 'Payload too large', undefined, cors);
    }
    const buf = await request.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      return errorResponse(null, 413, INVALID_PARAMS, 'Payload too large', undefined, cors);
    }
    const raw = new TextDecoder().decode(buf);

    let body: JsonRpcMessage;
    try {
      body = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return errorResponse(null, 400, PARSE_ERROR, 'Parse error', undefined, cors);
    }

    // Notifications (no id): accepted with 202 and no body (both eras — the
    // legacy era's notifications/initialized and notifications/cancelled land here).
    if (body.id === undefined && typeof body.method === 'string') {
      return new Response(null, { status: 202, headers: cors });
    }

    // Era selection (versioning spec, dual-era servers): an `initialize` request
    // or a pre-2026 MCP-Protocol-Version header (or none) selects the legacy leg;
    // a modern header selects the strict per-request-metadata leg.
    const headerVersion = request.headers.get('MCP-Protocol-Version');
    const legacyEra = body.method === 'initialize'
      || headerVersion === null
      || headerVersion < PROTOCOL_VERSION;

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

    if (legacyEra) {
      if (typeof body.method !== 'string'
          || (typeof body.id !== 'string' && typeof body.id !== 'number')) {
        return errorResponse(null, 400, INVALID_PARAMS, 'Invalid JSON-RPC request', undefined, cors);
      }
      const params = (body.params && typeof body.params === 'object'
        ? body.params : {}) as Record<string, unknown>;
      const legacyReq = { id: body.id as JsonRpcId, method: body.method, params };
      try {
        return await dispatchLegacy(env, request, legacyReq, auth, (id, p, a, name) =>
          runToolCall(env, id, p, a,
            { clientName: name, tasksDeclared: false, waitUntil: (p2) => ctx.waitUntil(p2) }, cors), cors);
      } catch (err) {
        console.error('[worldku-mcp] internal error (legacy)', body.method,
          err instanceof Error ? err.message : String(err));
        return errorResponse(legacyReq.id, 500, INTERNAL_ERROR, 'Internal error', undefined, cors);
      }
    }

    const validated = validateProtocol(request, body);
    if ('status' in validated) {
      const id = typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null;
      return errorResponse(id, validated.status, validated.code, validated.message, validated.data, cors);
    }

    try {
      return await dispatch(env, validated, auth, cors, (p) => ctx.waitUntil(p));
    } catch (err) {
      // Sanitized: internal error details (provider bodies, stacks) never leave.
      console.error('[worldku-mcp] internal error', validated.method,
        err instanceof Error ? err.message : String(err));
      return errorResponse(validated.id, 500, INTERNAL_ERROR, 'Internal error', undefined, cors);
    }
  },
};

export default worker;
