// The fixed, deterministic tool set. Every description opens with the manual-trigger
// constraint (tools fire only on the user's explicit ask — never from ambient
// association). Unknown arguments are rejected, never swallowed.

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MEMORY_TYPES = ['person_fact', 'experience', 'relationship'] as const;

export const TOOLS: ToolDef[] = [
  {
    name: 'memory_overview',
    title: 'Worldku memory overview',
    description:
      'Only call this tool when the user explicitly asks to see, list, or check their Worldku memories. '
      + 'Do not call it just because memory is mentioned in passing. '
      + 'Returns a one-line summary of the most recent memories (content, type, source, recorded date). '
      + 'Costs 1 read action.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
  {
    name: 'memory_search',
    title: 'Search Worldku memories',
    description:
      'Only call this tool when the user explicitly asks to search or recall something from their Worldku memory. '
      + 'Semantic search over stored memories; returns matching memories with source and dates. '
      + 'Costs 1 read action.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, description: 'What to search for, in natural language.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 8).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_recall',
    title: 'Recall Worldku memories (filtered)',
    description:
      'Only call this tool when the user explicitly asks for their Worldku memories filtered by time, type, or source '
      + '(e.g. "my memories from last week"). Returns memories newest-first with pagination. '
      + 'Costs 1 read action.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string', description: 'ISO date/datetime — only memories recorded at or after this instant.' },
        to: { type: 'string', description: 'ISO date/datetime — only memories recorded before this instant.' },
        memory_type: { enum: [...MEMORY_TYPES], description: 'Filter by memory type.' },
        source: { type: 'string', description: 'Filter by source key (as shown in overview results).' },
        cursor: { type: 'string', description: 'Opaque pagination cursor from a previous result.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Page size (default 20).' },
      },
    },
  },
  {
    name: 'memory_save',
    title: 'Save this conversation to Worldku memory',
    description:
      'Only call this tool when the user explicitly asks to save the conversation to their Worldku memory. '
      + 'Send ONLY the dialogue between the user and the assistant — no thinking, no tool calls, no system content. '
      + 'If this session was saved before, send only the messages AFTER the last save, and include the anchor '
      + 'message from the previous receipt as the first element so the server can align the increment. '
      + 'Any length is accepted in one call — never split into batches. '
      + 'Memory extraction runs asynchronously after the call returns; cancelling a task does not stop extraction '
      + 'that is already enqueued. Costs 1 save action (also when the content turns out to be a duplicate).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        messages: {
          type: 'array',
          minItems: 1,
          description: 'The conversation transcript, one element per message, in order.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              role: { enum: ['user', 'assistant'] },
              content: { type: 'string', minLength: 1 },
            },
            required: ['role', 'content'],
          },
        },
        title: { type: 'string', description: 'Optional conversation title, shown on the source page.' },
      },
      required: ['messages'],
    },
  },
];

export interface ArgError {
  message: string;
}

/** Minimal strict validation for our own schemas: unknown fields are errors
 *  (a typo must fail loudly, never silently produce a write). */
export function validateArgs(def: ToolDef, args: Record<string, unknown>): ArgError | null {
  const schema = def.inputSchema as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  const props = schema.properties ?? {};
  for (const key of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) {
      return { message: `Unknown argument '${key}' for ${def.name}. Allowed: ${Object.keys(props).join(', ') || '(none)'}.` };
    }
  }
  for (const req of schema.required ?? []) {
    if (args[req] === undefined) return { message: `Missing required argument '${req}' for ${def.name}.` };
  }
  for (const [key, value] of Object.entries(args)) {
    const p = props[key]!;
    if (p['type'] === 'string' && typeof value !== 'string') {
      return { message: `Argument '${key}' must be a string.` };
    }
    if (p['type'] === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) {
      return { message: `Argument '${key}' must be an integer.` };
    }
    if (Array.isArray(p['enum']) && !(p['enum'] as unknown[]).includes(value)) {
      return { message: `Argument '${key}' must be one of: ${(p['enum'] as unknown[]).join(', ')}.` };
    }
    if (p['type'] === 'integer' && typeof value === 'number') {
      const min = p['minimum'] as number | undefined;
      const max = p['maximum'] as number | undefined;
      if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
        return { message: `Argument '${key}' must be between ${min ?? '-inf'} and ${max ?? 'inf'}.` };
      }
    }
  }
  return null;
}

/** memory_save.messages element-level strict validation. */
export function validateMessages(value: unknown): { role: string; content: string }[] | ArgError {
  if (!Array.isArray(value) || value.length === 0) {
    return { message: 'messages must be a non-empty array.' };
  }
  const out: { role: string; content: string }[] = [];
  for (const [i, m] of value.entries()) {
    if (m === null || typeof m !== 'object' || Array.isArray(m)) {
      return { message: `messages[${i}] must be an object.` };
    }
    const rec = m as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (key !== 'role' && key !== 'content') {
        return { message: `Unknown field '${key}' in messages[${i}]. Allowed: role, content.` };
      }
    }
    if (rec['role'] !== 'user' && rec['role'] !== 'assistant') {
      return { message: `messages[${i}].role must be 'user' or 'assistant'.` };
    }
    if (typeof rec['content'] !== 'string' || rec['content'].length === 0) {
      return { message: `messages[${i}].content must be a non-empty string.` };
    }
    out.push({ role: rec['role'], content: rec['content'] });
  }
  return out;
}
