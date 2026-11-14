import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { safeEqual, signPayload, verifySignature } from '../src/signature.js';

const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
const secret = 'test-app-secret';

describe('X-Hub-Signature-256 verification', () => {
  it('matches an independently computed HMAC-SHA256 (known vector)', () => {
    // RFC 4231 test case 2
    expect(signPayload('what do ya want for nothing?', 'Jefe')).toBe(
      'sha256=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
    );
  });

  it('accepts a valid signature, in either hex case', () => {
    const sig = signPayload(body, secret);
    expect(verifySignature(body, sig, secret)).toBe(true);
    expect(verifySignature(body, sig.toUpperCase().replace('SHA256=', 'sha256='), secret)).toBe(true);
  });

  it('rejects a body changed by a single byte', () => {
    const sig = signPayload(body, secret);
    expect(verifySignature(Buffer.from(body.toString().replace('entry', 'Entry')), sig, secret)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifySignature(body, signPayload(body, 'other-secret'), secret)).toBe(false);
  });

  it.each([
    ['missing header', undefined],
    ['empty header', ''],
    ['no prefix', crypto.createHmac('sha256', secret).update(body).digest('hex')],
    ['sha1 prefix', 'sha1=' + 'a'.repeat(40)],
    ['truncated digest', 'sha256=abcd'],
    ['non-hex digest', 'sha256=' + 'z'.repeat(64)]
  ])('rejects %s without throwing', (_name, header) => {
    expect(verifySignature(body, header, secret)).toBe(false);
  });

  it('signs the exact bytes: the same JSON with different whitespace has a different signature', () => {
    const sig = signPayload(body, secret);
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(verifySignature(reformatted, sig, secret)).toBe(false);
  });

  it('safeEqual compares strings of different lengths without throwing', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});
