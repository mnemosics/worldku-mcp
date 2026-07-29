// Query embedding via the Worldku AI gateway service binding (bge-m3, symmetric —
// queries and passages share the embedding space). The binding ignores the host;
// only the path matters.
import type { Env } from './env';

export async function embedQuery(env: Env, text: string): Promise<number[]> {
  const res = await env.GATEWAY.fetch('https://gateway.internal/v1/embed', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-worldku-app-key': env.MCP_APP_KEY,
    },
    body: JSON.stringify({ appId: env.MCP_APP_ID, sceneId: env.MCP_SCENE_ID, texts: [text] }),
  });
  if (!res.ok) {
    // Provider/gateway error bodies never leave this worker.
    throw new Error(`embed_failed_${res.status}`);
  }
  const parsed = (await res.json()) as { embeddings?: number[][] };
  const vec = parsed.embeddings?.[0];
  if (!vec || vec.length === 0) throw new Error('embed_empty');
  return vec;
}

/** pgvector literal for RPC text parameters. */
export function vectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}
