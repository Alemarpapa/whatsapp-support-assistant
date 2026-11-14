import crypto from 'node:crypto';

/** Hex HMAC-SHA256 of the raw body, in the `sha256=<hex>` form Meta sends in X-Hub-Signature-256. */
export function signPayload(rawBody: Buffer | string, appSecret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

/** Constant-time string comparison. Hashing first makes both inputs the same length. */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Verifies X-Hub-Signature-256 against the exact bytes received.
 * Must run on the raw body: re-serialising parsed JSON can change bytes and break the signature.
 */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  return safeEqual(header.toLowerCase(), signPayload(rawBody, appSecret));
}
