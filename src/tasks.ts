// Tasks extension (io.modelcontextprotocol/tasks): taskId → import batch mapping.
// Polling is the whole story (no notifications/tasks push). Cancellation is
// cooperative and acknowledged, but already-enqueued extraction is not interrupted
// (stated in the memory_save tool description).
import type { Env } from './env';
import { selectRows } from './db';

export interface TaskRow {
  task_id: string;
  user_id: string;
  batch_id: string;
  created_at: string;
  expires_at: string;
}

interface BatchRow {
  id: string;
  status: 'queued' | 'processing' | 'done' | 'failed';
  stats: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface TaskState {
  taskId: string;
  status: 'working' | 'completed' | 'failed';
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs: number;
  statusMessage?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export async function getTask(env: Env, userId: string, taskId: string): Promise<TaskState | null> {
  const tasks = await selectRows<TaskRow>(
    env,
    'mcp_tasks',
    `task_id=eq.${encodeURIComponent(taskId)}&user_id=eq.${userId}&select=task_id,user_id,batch_id,created_at,expires_at&limit=1`,
  );
  const task = tasks[0];
  if (!task || Date.parse(task.expires_at) <= Date.now()) return null;

  const batches = await selectRows<BatchRow>(
    env,
    'import_batches',
    `id=eq.${task.batch_id}&select=id,status,stats,error,created_at,finished_at&limit=1`,
  );
  const batch = batches[0];
  if (!batch) return null;

  const base = {
    taskId: task.task_id,
    createdAt: task.created_at,
    lastUpdatedAt: batch.finished_at ?? batch.created_at,
    ttlMs: Math.max(0, Date.parse(task.expires_at) - Date.parse(task.created_at)),
    pollIntervalMs: 3000,
  };

  if (batch.status === 'queued' || batch.status === 'processing') {
    return { ...base, status: 'working', statusMessage: 'Memory extraction in progress.' };
  }
  if (batch.status === 'done') {
    const ingested = typeof batch.stats?.['autoIngested'] === 'number'
      ? (batch.stats['autoIngested'] as number)
      : null;
    const summary = ingested === null
      ? 'Extraction completed.'
      : `Extraction completed: ${ingested} memories written or updated.`;
    return {
      ...base,
      status: 'completed',
      statusMessage: summary,
      result: {
        resultType: 'complete',
        content: [{ type: 'text', text: summary }],
        isError: false,
      },
    };
  }
  // failed — the batch error is an internal marker (e.g. work_jobs_failed); safe to name.
  return {
    ...base,
    status: 'failed',
    statusMessage: 'Memory extraction failed.',
    error: { code: 1001, message: `Memory extraction failed (${batch.error ?? 'unknown'}). Saving again is safe — duplicates are skipped.` },
  };
}
