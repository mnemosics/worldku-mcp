// MCP 2026-07-28 per-request metadata validation (stateless — every request is
// self-describing). Header/body mirror mismatches are HeaderMismatch (-32020) per
// the Streamable HTTP binding; missing required _meta fields are Invalid params
// (-32602); an unsupported protocol version is -32022 with the supported list.
import {
  HEADER_MISMATCH,
  INVALID_PARAMS,
  INVALID_REQUEST,
  UNSUPPORTED_PROTOCOL_VERSION,
  type JsonRpcId,
  type JsonRpcMessage,
} from './jsonrpc';
import { SUPPORTED_VERSIONS } from './env';

export interface RequestMeta {
  protocolVersion: string;
  clientCapabilities: Record<string, unknown>;
  clientInfo?: { name?: unknown; version?: unknown };
}

export interface ValidatedRequest {
  id: JsonRpcId;
  method: string;
  params: Record<string, unknown>;
  meta: RequestMeta;
}

export interface ProtocolError {
  status: number;
  code: number;
  message: string;
  data?: unknown;
}

const B64_SENTINEL = /^=\?base64\?(.*)\?=$/;

/** Decode the `=?base64?…?=` sentinel form of Mcp-Name (value encoding, streamable-http). */
export function decodeHeaderValue(value: string): string {
  const m = B64_SENTINEL.exec(value);
  if (!m) return value;
  try {
    const bytes = Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return value; // undecodable sentinel → compare raw (will mismatch and reject)
  }
}

export function validateProtocol(
  request: Request,
  body: JsonRpcMessage,
): ValidatedRequest | ProtocolError {
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string'
      || (typeof body.id !== 'string' && typeof body.id !== 'number')) {
    return { status: 400, code: INVALID_REQUEST, message: 'Invalid JSON-RPC request' };
  }
  const method = body.method;
  const params = (body.params && typeof body.params === 'object'
    ? body.params : {}) as Record<string, unknown>;
  const meta = (params['_meta'] && typeof params['_meta'] === 'object'
    ? params['_meta'] : {}) as Record<string, unknown>;

  const protocolVersion = meta['io.modelcontextprotocol/protocolVersion'];
  const clientCapabilities = meta['io.modelcontextprotocol/clientCapabilities'];
  if (typeof protocolVersion !== 'string'
      || clientCapabilities === undefined || clientCapabilities === null
      || typeof clientCapabilities !== 'object') {
    return {
      status: 400,
      code: INVALID_PARAMS,
      message: 'Missing required _meta fields (io.modelcontextprotocol/protocolVersion, io.modelcontextprotocol/clientCapabilities)',
    };
  }

  const headerVersion = request.headers.get('MCP-Protocol-Version');
  if (headerVersion === null) {
    return { status: 400, code: HEADER_MISMATCH, message: 'Missing required MCP-Protocol-Version header' };
  }
  if (headerVersion !== protocolVersion) {
    return {
      status: 400,
      code: HEADER_MISMATCH,
      message: `Header mismatch: MCP-Protocol-Version header value '${headerVersion}' does not match body value '${protocolVersion}'`,
    };
  }
  if (!SUPPORTED_VERSIONS.includes(protocolVersion)) {
    return {
      status: 400,
      code: UNSUPPORTED_PROTOCOL_VERSION,
      message: 'Unsupported protocol version',
      data: { supported: SUPPORTED_VERSIONS, requested: protocolVersion },
    };
  }

  const headerMethod = request.headers.get('Mcp-Method');
  if (headerMethod === null) {
    return { status: 400, code: HEADER_MISMATCH, message: 'Missing required Mcp-Method header' };
  }
  if (headerMethod !== method) {
    return {
      status: 400,
      code: HEADER_MISMATCH,
      message: `Header mismatch: Mcp-Method header value '${headerMethod}' does not match body value '${method}'`,
    };
  }

  if (method === 'tools/call') {
    const headerName = request.headers.get('Mcp-Name');
    const bodyName = params['name'];
    if (headerName === null) {
      return { status: 400, code: HEADER_MISMATCH, message: 'Missing required Mcp-Name header' };
    }
    if (typeof bodyName !== 'string' || decodeHeaderValue(headerName) !== bodyName) {
      return {
        status: 400,
        code: HEADER_MISMATCH,
        message: `Header mismatch: Mcp-Name header value '${headerName}' does not match body value '${String(bodyName)}'`,
      };
    }
  }

  const clientInfo = meta['io.modelcontextprotocol/clientInfo'];
  return {
    id: body.id,
    method,
    params,
    meta: {
      protocolVersion,
      clientCapabilities: clientCapabilities as Record<string, unknown>,
      ...(clientInfo && typeof clientInfo === 'object'
        ? { clientInfo: clientInfo as { name?: unknown; version?: unknown } }
        : {}),
    },
  };
}

export function clientDeclaredTasks(meta: RequestMeta): boolean {
  const ext = (meta.clientCapabilities['extensions'] ?? {}) as Record<string, unknown>;
  return typeof ext === 'object' && ext !== null
    && Object.prototype.hasOwnProperty.call(ext, 'io.modelcontextprotocol/tasks');
}

export function clientName(meta: RequestMeta): string | undefined {
  const name = meta.clientInfo?.name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined;
}
