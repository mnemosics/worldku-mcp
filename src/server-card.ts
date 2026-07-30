// MCP Server Card + AI Catalog discovery surface (SEP-2127 experimental
// extension, modelcontextprotocol/experimental-ext-server-card @ draft).
// The card lives at GET <streamable-http-url>/server-card (the extension's
// reserved location); domain-level discovery starts at
// /.well-known/ai-catalog.json. Cards intentionally omit tool listings —
// clients list primitives at runtime via tools/list.
import type { Env } from './env';
import { SERVER_VERSION } from './env';

export const SERVER_CARD_PATH = '/mcp/server-card';
export const AI_CATALOG_PATH = '/.well-known/ai-catalog.json';

function discoveryResponse(body: unknown, mediaType: string): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      'Content-Type': mediaType,
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export function serverCardResponse(env: Env): Response {
  return discoveryResponse({
    $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    name: 'com.worldku/memory',
    version: SERVER_VERSION,
    title: 'Worldku Memory',
    description:
      'Save conversations from any MCP client into your Worldku memory, and search or recall them '
      + 'from anywhere. Tools fire only on the user\'s explicit ask. Docs: https://www.worldku.com/en/docs/mcp',
    websiteUrl: 'https://www.worldku.com/en/docs/mcp',
    remotes: [
      {
        type: 'streamable-http',
        url: env.RESOURCE_URI,
        headers: [
          {
            name: 'Authorization',
            description:
              'Worldku MCP access key (create one at worldku.com under Memory manager → AI tools). '
              + 'Clients that implement MCP authorization can omit this header and use the OAuth 2.1 '
              + 'authorization server advertised by the protected-resource metadata instead.',
            isRequired: false,
            isSecret: true,
            value: 'Bearer {access_key}',
            variables: {
              access_key: {
                description: 'Access key issued in the Worldku Hub (shown once at creation).',
                isRequired: true,
                isSecret: true,
              },
            },
          },
        ],
        supportedProtocolVersions: ['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'],
      },
    ],
  }, 'application/mcp-server-card+json');
}

export function aiCatalogResponse(env: Env): Response {
  const origin = new URL(env.RESOURCE_URI).origin;
  return discoveryResponse({
    specVersion: '1.0',
    entries: [
      {
        identifier: 'urn:air:worldku.com:mcp:memory',
        type: 'application/mcp-server-card+json',
        url: `${origin}${SERVER_CARD_PATH}`,
      },
    ],
  }, 'application/ai-catalog+json');
}
