// Canonical Worldku archive-dedup hash contract. MUST stay byte-identical to the
// platform's import pipeline (message hash = sha256(`${role}|${content}`); the
// whole-conversation hash is derived server-side from the per-message hashes).

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function messageContentHash(role: string, content: string): Promise<string> {
  return sha256Hex(`${role}|${content}`);
}

/** Constant-time comparison of two equal-length hex digests. */
export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
