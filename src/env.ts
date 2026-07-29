export interface Env {
  /** Service binding to the Worldku AI gateway (query embeddings). */
  GATEWAY: Fetcher;
  // secrets
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  MCP_APP_KEY: string;
  // vars (wrangler.toml)
  MCP_APP_ID: string;
  MCP_SCENE_ID: string;
  BILLING_APP_ID: string;
  RESOURCE_URI: string;
  AUTH_SERVER_URL: string;
  ALLOWED_ORIGINS?: string;
  READ_CAP?: string;
  WRITE_CAP?: string;
  PAYLOAD_MAX_BYTES?: string;
  OVERVIEW_N?: string;
  TASK_TTL_MS?: string;
  EXTRACTOR_VERSION?: string;
}

export const SERVER_NAME = 'worldku-mcp';
export const SERVER_VERSION = '0.1.0';
export const PROTOCOL_VERSION = '2026-07-28';
export const SUPPORTED_VERSIONS = [PROTOCOL_VERSION];
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

export const intVar = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
