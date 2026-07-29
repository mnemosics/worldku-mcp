// Usage accounting: every tool call books a charged-0 usage action (the billing
// pipeline runs for real; the amount is zero — call-volume data for pricing) and
// bumps the per-user daily sanity counter FIRST (over-cap calls are refused before
// any booking or work happens).
import type { Env } from './env';
import { intVar } from './env';
import { callRpc } from './db';
import { sha256Hex } from './hash';

export type UsageKind = 'read' | 'write';

export interface UsageGate {
  allowed: boolean;
  used: number;
  cap: number;
  resetsAt: string;
}

export async function bumpUsage(env: Env, userId: string, kind: UsageKind): Promise<UsageGate> {
  const cap = kind === 'read' ? intVar(env.READ_CAP, 200) : intVar(env.WRITE_CAP, 50);
  const out = await callRpc<{ allowed: boolean; used: number; resets_at: string }>(
    env,
    'memory_mcp_bump_usage',
    { p_user_id: userId, p_kind: kind, p_cap: cap },
  );
  return { allowed: out.allowed, used: out.used, cap, resetsAt: out.resets_at };
}

const ACTION_OF: Record<UsageKind, string> = {
  read: 'memory.mcp.read',
  write: 'memory.mcp.save',
};

/** Book the charged-0 usage action. Amount comes from the registry row (0); the
 *  idempotency key is per-call (a retried HTTP request re-books — visible, amount 0). */
export async function bookUsageAction(env: Env, userId: string, kind: UsageKind): Promise<void> {
  const actionKey = ACTION_OF[kind];
  const idempotencyKey = `mcp:${crypto.randomUUID()}`;
  const requestHash = await sha256Hex(
    ['amount', userId, env.BILLING_APP_ID, actionKey, '', ''].join('|'),
  );
  await callRpc(env, 'spend_credits_by_amount', {
    p_user_id: userId,
    p_app_id: env.BILLING_APP_ID,
    p_action_key: actionKey,
    p_amount: null,
    p_ref_kind: 'mcp_call',
    p_ref_id: null,
    p_idempotency_key: idempotencyKey,
    p_request_hash: requestHash,
    p_metadata: { leg: 'mcp' },
  });
}
