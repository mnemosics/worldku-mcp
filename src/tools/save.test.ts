import { describe, it, expect } from 'vitest';
import { sourceIdentityOf, receiptText, anchorLine } from './save';

describe('sourceIdentityOf (clientInfo.name → source key, display-only attribution)', () => {
  it('maps the known AI tools to their canonical keys', () => {
    expect(sourceIdentityOf('Claude Code').key).toBe('claude_code');
    expect(sourceIdentityOf('claude-code').key).toBe('claude_code');
    expect(sourceIdentityOf('Codex CLI').key).toBe('codex');
    expect(sourceIdentityOf('Gemini CLI').key).toBe('gemini_cli');
  });

  it('slugifies unknown clients under the mcp_ namespace', () => {
    expect(sourceIdentityOf('GLM Terminal 4.5').key).toBe('mcp_glm_terminal_4_5');
    expect(sourceIdentityOf('GLM Terminal 4.5').display).toBe('GLM Terminal 4.5');
  });

  it('handles a missing clientInfo.name', () => {
    const id = sourceIdentityOf(undefined);
    expect(id.key).toBe('mcp_mcp_client');
    expect(id.display).toBe('MCP client');
  });
});

describe('receipt rendering', () => {
  const msgs = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'x'.repeat(200) },
  ];

  it('anchor previews the last message, truncated', () => {
    const line = anchorLine(msgs);
    expect(line).toContain('[assistant]');
    expect(line).toContain('…');
    expect(line.length).toBeLessThan(220);
  });

  it('duplicate receipt states the call still counted', () => {
    const text = receiptText(
      { decision: 'duplicate', received: 2, new_count: 0, total_messages: 2 },
      msgs,
      'Saves used today: 3/50.',
    );
    expect(text).toContain('still counted');
    expect(text).toContain('Saves used today: 3/50.');
    expect(text).not.toContain('extraction runs asynchronously'); // nothing was enqueued
  });
});
