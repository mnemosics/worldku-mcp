import { describe, expect, it } from 'vitest';
import worker from './index';
import { makeEnv } from './test-helpers';

// Server Card + AI Catalog discovery (SEP-2127 experimental extension): both
// documents are public (no auth), typed with their reserved media types, and
// the catalog must point at the card's actual URL.

const env = makeEnv();

async function get(path: string): Promise<Response> {
  return worker.fetch(new Request(`https://mcp.worldku.com${path}`), env, {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext);
}

describe('server card discovery', () => {
  it('serves the Server Card at the reserved location with its media type', async () => {
    const res = await get('/mcp/server-card');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/mcp-server-card+json');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const card = await res.json() as Record<string, unknown>;
    expect(card).toMatchObject({
      $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
      name: 'com.worldku/memory',
    });
    const remote = (card['remotes'] as Array<Record<string, unknown>>)[0]!;
    expect(remote).toMatchObject({ type: 'streamable-http', url: env.RESOURCE_URI });
    expect(remote['supportedProtocolVersions']).toEqual(
      ['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'],
    );
    // Cards intentionally omit primitive listings — tools are listed at runtime.
    expect(card['tools']).toBeUndefined();
  });

  it('serves the AI Catalog at the well-known URI, pointing at the card', async () => {
    const res = await get('/.well-known/ai-catalog.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/ai-catalog+json');
    const catalog = await res.json() as { specVersion: string; entries: Array<Record<string, unknown>> };
    expect(catalog.specVersion).toBe('1.0');
    expect(catalog.entries).toEqual([
      {
        identifier: 'urn:air:worldku.com:mcp:memory',
        type: 'application/mcp-server-card+json',
        url: 'https://mcp.worldku.com/mcp/server-card',
      },
    ]);
  });

  it('discovery endpoints are read-only (405 on POST) and need no auth', async () => {
    for (const path of ['/mcp/server-card', '/.well-known/ai-catalog.json']) {
      const res = await worker.fetch(new Request(`https://mcp.worldku.com${path}`, { method: 'POST' }), env, {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext);
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('GET');
    }
  });
});
