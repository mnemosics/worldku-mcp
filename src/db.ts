// Thin PostgREST/RPC seam over the Worldku backend (service-role; the key never
// leaves the worker). Every call carries an abort timeout so a hung TCP connection
// can never stall a request to the platform CPU limit. Provider error bodies are
// captured into DbError.detail for logs only — they are never echoed to clients.
import type { Env } from './env';

const DB_TIMEOUT_MS = 15_000;

export class DbError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail: string,
  ) {
    super(`db_${status}:${code}`);
  }
}

async function dbFetch(env: Env, path: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DB_TIMEOUT_MS);
  try {
    return await fetch(`${env.SUPABASE_URL}${path}`, {
      ...init,
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function raiseOnError(res: Response): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  let code = 'unknown';
  try {
    const parsed = JSON.parse(body) as { code?: string; message?: string };
    code = parsed.code ?? 'unknown';
    // PostgREST surfaces RAISE EXCEPTION messages in `message`.
    if (code === 'unknown' && parsed.message) code = parsed.message.slice(0, 60);
  } catch {
    /* non-JSON error body */
  }
  throw new DbError(res.status, code, body.slice(0, 300));
}

export async function callRpc<T>(env: Env, fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await dbFetch(env, `/rest/v1/rpc/${fn}`, {
    method: 'POST',
    body: JSON.stringify(args),
  });
  await raiseOnError(res);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export async function selectRows<T>(env: Env, table: string, query: string): Promise<T[]> {
  const res = await dbFetch(env, `/rest/v1/${table}?${query}`, { method: 'GET' });
  await raiseOnError(res);
  return (await res.json()) as T[];
}

export async function insertRow(env: Env, table: string, row: Record<string, unknown>): Promise<void> {
  const res = await dbFetch(env, `/rest/v1/${table}`, {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
  await raiseOnError(res);
}

export async function patchRows(
  env: Env,
  table: string,
  query: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const res = await dbFetch(env, `/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  await raiseOnError(res);
}
