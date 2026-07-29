import { describe, it, expect } from 'vitest';
import { constantTimeEqualHex, messageContentHash, sha256Hex } from './hash';

describe('hash contract', () => {
  it('message hash = sha256(`${role}|${content}`) — platform archive contract', async () => {
    expect(await messageContentHash('user', 'hi')).toBe(await sha256Hex('user|hi'));
    // pinned vector so a refactor can never silently change the contract
    expect(await sha256Hex('user|hi')).toBe(
      '48aa74f47226332f91763c0aa82d11a573407ebfd69be7c1f04fad9ce22cf160',
    );
  });
});

describe('constantTimeEqualHex', () => {
  it('accepts equal digests', () => {
    expect(constantTimeEqualHex('abc123', 'abc123')).toBe(true);
  });
  it('rejects same-length different digests', () => {
    expect(constantTimeEqualHex('abc123', 'abc124')).toBe(false);
  });
  it('rejects length mismatch without comparing content', () => {
    expect(constantTimeEqualHex('abc', 'abcd')).toBe(false);
  });
});
