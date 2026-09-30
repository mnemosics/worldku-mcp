// memory_save: hash the transcript client-side of the DB (same contract as the
// platform import pipeline), then one atomic RPC does source registration, the
// R1/R2'/R3 dedup decision, archive writes and extraction-job seeding. Extraction
// itself runs on the platform's import worker (DB queue decoupling — no direct
// worker-to-worker call).
import type { Env } from '../env';
import { intVar } from '../env';
import { callRpc, insertRow, DbError } from '../db';
import { messageContentHash } from '../hash';

export interface SaveReceipt {
  decision: 'new' | 'appended' | 'duplicate';
  received: number;
  new_count: number;
  total_messages: number;
  batch_id?: string;
}

export interface SourceIdentity {
  key: string;
  display: string;
}

/** Map the self-reported clientInfo.name to a stable source key. Display-only
 *  attribution (the spec forbids using clientInfo for security decisions). */
export function sourceIdentityOf(clientName: string | undefined): SourceIdentity {
  const raw = (clientName ?? 'MCP client').trim().slice(0, 80);
  const n = raw.toLowerCase();
  if (/claude[\s_-]?code/.test(n)) return { key: 'claude_code', display: raw };
  if (/codex/.test(n)) return { key: 'codex', display: raw };
  if (/gemini/.test(n)) return { key: 'gemini_cli', display: raw };
  const slug = n.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return { key: `mcp_${slug || 'client'}`, display: raw };
}

export class SourceBusyError extends Error {}

/** The extraction pipeline version the save RPC folds into each seeded segment
 *  job's idempotency key. The platform owns it — memory_current_extractor_version(),
 *  defined by its latest migration — and this worker keeps no copy: it is read on
 *  every save, so a platform extractor bump needs no change here. A missing or
 *  non-string value fails the save (a NULL would silently void the key). */
async function currentExtractorVersion(env: Env): Promise<string> {
  const version = await callRpc<unknown>(env, 'memory_current_extractor_version', {});
  if (typeof version !== 'string' || version === '') throw new Error('extractor_version_invalid');
  return version;
}

export async function runSave(
  env: Env,
  userId: string,
  source: SourceIdentity,
  title: string | undefined,
  messages: { role: string; content: string }[],
): Promise<SaveReceipt> {
  const [extractorVersion, withHashes] = await Promise.all([
    currentExtractorVersion(env),
    Promise.all(
      messages.map(async (m) => ({
        role: m.role,
        content: m.content,
        content_hash: await messageContentHash(m.role, m.content),
      })),
    ),
  ]);
  try {
    return await callRpc<SaveReceipt>(env, 'memory_mcp_save_conversation', {
      p_user_id: userId,
      p_source_key: source.key,
      p_source_name: source.display,
      p_title: title ?? null,
      p_messages: withHashes,
      p_extractor_version: extractorVersion,
    });
  } catch (err) {
    // ERRCODE 55006 = the one-active-batch gate (previous save still extracting).
    if (err instanceof DbError && (err.code === '55006' || err.detail.includes('mcp_source_busy'))) {
      throw new SourceBusyError();
    }
    throw err;
  }
}

export function anchorLine(messages: { role: string; content: string }[]): string {
  const last = messages[messages.length - 1]!;
  const preview = last.content.length > 120 ? `${last.content.slice(0, 120)}…` : last.content;
  return `Anchor (include this message first in the next incremental save): [${last.role}] "${preview}"`;
}

export function receiptText(
  receipt: SaveReceipt,
  messages: { role: string; content: string }[],
  usedLine: string,
): string {
  const lines: string[] = [];
  if (receipt.decision === 'new') {
    lines.push(`Saved as a new conversation: ${receipt.received} messages received.`);
  } else if (receipt.decision === 'appended') {
    lines.push(
      `Appended to the previously saved conversation: ${receipt.received} received, `
      + `${receipt.new_count} new (conversation now has ${receipt.total_messages} messages).`,
    );
  } else {
    lines.push('Already saved — identical content, nothing new to store. The call still counted.');
  }
  lines.push(anchorLine(messages));
  if (receipt.decision !== 'duplicate') {
    lines.push('Memory extraction runs asynchronously and usually lands within a couple of minutes.');
  }
  lines.push(usedLine);
  return lines.join('\n');
}

/** Mint the opaque task handle for tasks-capable clients (never exposes batch ids). */
export async function mintTask(env: Env, userId: string, batchId: string): Promise<{
  taskId: string;
  ttlMs: number;
}> {
  const taskId = `wkt_${crypto.randomUUID().replaceAll('-', '')}`;
  const ttlMs = intVar(env.TASK_TTL_MS, 86_400_000);
  await insertRow(env, 'mcp_tasks', {
    task_id: taskId,
    user_id: userId,
    batch_id: batchId,
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  });
  return { taskId, ttlMs };
}
