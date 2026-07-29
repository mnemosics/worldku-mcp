// JSON-RPC 2.0 shapes + MCP 2026-07-28 error codes. Business failures never mint
// protocol error codes — they are tool execution errors (isError: true).

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const HEADER_MISMATCH = -32020;
export const MISSING_CLIENT_CAPABILITY = -32021;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

export type JsonRpcId = string | number;

export interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export function errorBody(id: JsonRpcId | null, code: number, message: string, data?: unknown): string {
  const error: RpcError = data === undefined ? { code, message } : { code, message, data };
  return JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), error });
}

export function errorResponse(
  id: JsonRpcId | null,
  status: number,
  code: number,
  message: string,
  data?: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(errorBody(id, code, message, data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function resultResponse(
  id: JsonRpcId,
  result: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
