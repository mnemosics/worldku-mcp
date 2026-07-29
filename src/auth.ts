// Two-leg auth, hard-isolated by token prefix (no fallback between legs):
//   wk_mcp_… — static access key (CLI clients), sha256 lookup + constant-time compare
//   wk_at_…  — OAuth 2.1 access token minted by the Worldku Hub AS, audience-bound
// Any other shape is rejected. Insufficient scope → 403 error="insufficient_scope".
import type { Env } from './env';
import { selectRows, patchRows } from './db';
import { sha256Hex, constantTimeEqualHex } from './hash';

export type Scope = 'memory:read' | 'memory:write';
export const ALL_SCOPES: Scope[] = ['memory:read', 'memory:write'];

export interface AuthContext {
  userId: string;
  scopes: ReadonlySet<string>;
  leg: 'static_key' | 'oauth';
}

export interface AuthFailure {
  status: 401 | 403;
  error: 'invalid_token' | 'insufficient_scope';
}

export function wwwAuthenticate(env: Env, failure?: AuthFailure): string {
  const prm = `resource_metadata="${new URL(env.RESOURCE_URI).origin}/.well-known/oauth-protected-resource"`;
  if (failure?.error === 'insufficient_scope') {
    return `Bearer error="insufficient_scope", scope="${ALL_SCOPES.join(' ')}", ${prm}`;
  }
  return `Bearer ${prm}, scope="${ALL_SCOPES.join(' ')}"`;
}

interface KeyRow {
  id: string;
  user_id: string;
  key_hash: string;
  revoked_at: string | null;
}

interface TokenRow {
  user_id: string;
  token_hash: string;
  scope: string;
  audience: string;
  expires_at: string;
  revoked_at: string | null;
}

export async function authenticate(
  env: Env,
  request: Request,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<AuthContext | AuthFailure> {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (!match) return { status: 401, error: 'invalid_token' };
  const token = match[1]!;

  if (token.startsWith('wk_mcp_')) {
    const hash = await sha256Hex(token);
    const rows = await selectRows<KeyRow>(
      env,
      'mcp_access_keys',
      `key_hash=eq.${hash}&revoked_at=is.null&select=id,user_id,key_hash,revoked_at&limit=1`,
    );
    const row = rows[0];
    if (!row || !constantTimeEqualHex(hash, row.key_hash)) {
      return { status: 401, error: 'invalid_token' };
    }
    // Connection freshness signal for the Hub key list — never on the hot path.
    waitUntil(
      patchRows(env, 'mcp_access_keys', `id=eq.${row.id}`, {
        last_used_at: new Date().toISOString(),
      }).catch(() => undefined),
    );
    return { userId: row.user_id, scopes: new Set(ALL_SCOPES), leg: 'static_key' };
  }

  if (token.startsWith('wk_at_')) {
    const hash = await sha256Hex(token);
    const rows = await selectRows<TokenRow>(
      env,
      'oauth_tokens',
      `token_hash=eq.${hash}&token_type=eq.access&revoked_at=is.null`
        + `&select=user_id,token_hash,scope,audience,expires_at,revoked_at&limit=1`,
    );
    const row = rows[0];
    if (!row || !constantTimeEqualHex(hash, row.token_hash)) {
      return { status: 401, error: 'invalid_token' };
    }
    if (Date.parse(row.expires_at) <= Date.now()) return { status: 401, error: 'invalid_token' };
    // RFC 8707 audience binding — tokens minted for any other resource are refused,
    // never passed through.
    if (row.audience !== env.RESOURCE_URI) return { status: 401, error: 'invalid_token' };
    return { userId: row.user_id, scopes: new Set(row.scope.split(' ')), leg: 'oauth' };
  }

  return { status: 401, error: 'invalid_token' };
}

export function isAuthFailure(x: AuthContext | AuthFailure): x is AuthFailure {
  return (x as AuthFailure).status !== undefined;
}
