// Dual-era leg: MCP revisions 2025-03-26 … 2025-11-25 (initialize-handshake era).
// The 2026-07-28 versioning spec sanctions dual-era servers explicitly; every
// production client today (Claude Code, claude.ai, Codex, Gemini CLI) still
// speaks this era, so the modern-only surface would have zero working clients.
// Served STATELESSLY: no Mcp-Session-Id is ever minted (sessions are optional in
// this era; sessionless servers are first-class), no SSE streams (single JSON
// responses; clients must accept them), no server-initiated requests. Drop this
// module when the client ecosystem reaches 2026-07-28.
import type { Env } from './env';
import { SERVER_NAME, SERVER_VERSION } from './env';
import {
  errorResponse,
  resultResponse,
  METHOD_NOT_FOUND,
  type JsonRpcId,
} from './jsonrpc';
import type { AuthContext } from './auth';
import { TOOLS } from './tools/defs';

export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const LEGACY_DEFAULT = '2025-11-25';

export interface LegacyRequest {
  id: JsonRpcId;
  method: string;
  params: Record<string, unknown>;
}

/** clientInfo only travels in `initialize` in this era and we keep no session
 *  state, so per-call attribution falls back to the User-Agent product token
 *  (e.g. `claude-code/2.1.217 (…)` → `claude-code`). Display-only, like
 *  clientInfo itself. */
export function legacyClientName(request: Request, params: Record<string, unknown>): string | undefined {
  const info = params['clientInfo'];
  if (info && typeof info === 'object') {
    const name = (info as Record<string, unknown>)['name'];
    if (typeof name === 'string' && name.trim() !== '') return name.trim();
  }
  const ua = request.headers.get('User-Agent') ?? '';
  const product = /^([A-Za-z0-9._-]+)\//.exec(ua)?.[1];
  return product ?? undefined;
}

export type LegacyToolRunner = (
  id: JsonRpcId,
  params: Record<string, unknown>,
  auth: AuthContext,
  clientName: string | undefined,
) => Promise<Response>;

export async function dispatchLegacy(
  env: Env,
  request: Request,
  req: LegacyRequest,
  auth: AuthContext,
  runTool: LegacyToolRunner,
  cors: Record<string, string>,
): Promise<Response> {
  switch (req.method) {
    case 'initialize': {
      const requested = req.params['protocolVersion'];
      const negotiated = typeof requested === 'string' && LEGACY_VERSIONS.includes(requested)
        ? requested
        : LEGACY_DEFAULT;
      // No Mcp-Session-Id header: this server is sessionless by construction.
      return resultResponse(req.id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          'Worldku memory access. Tools only fire on the user\'s explicit ask: '
          + 'memory_save stores the current conversation, memory_overview/memory_search/memory_recall read memories back.',
      }, cors);
    }

    case 'ping':
      return resultResponse(req.id, {}, cors);

    case 'tools/list':
      return resultResponse(req.id, { tools: TOOLS }, cors);

    case 'tools/call':
      return runTool(req.id, req.params, auth, legacyClientName(request, req.params));

    default:
      return errorResponse(req.id, 404, METHOD_NOT_FOUND, `Method not found: ${req.method}`, undefined, cors);
  }
}
