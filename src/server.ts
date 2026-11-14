import http from 'node:http';
import type { SupportAssistant } from './assistant.js';
import { WebhookPayloadSchema } from './schemas.js';
import { safeEqual, verifySignature } from './signature.js';

/** Meta states webhook payloads can be up to 3 MB. */
export const MAX_BODY_BYTES = 3 * 1024 * 1024;

export interface ServerOptions {
  appSecret: string;
  verifyToken: string;
  assistant: SupportAssistant;
  log?: (line: string) => void;
}

function readBody(req: http.IncomingMessage): Promise<Buffer | 'too_large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Keep draining so the 413 can be delivered, but stop buffering.
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? 'too_large' : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createWebhookServer({ appSecret, verifyToken, assistant, log = () => {} }: ServerOptions): http.Server {
  const send = (res: http.ServerResponse, status: number, body = '') => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(body);
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/webhook') return send(res, 404, 'Not found');

      // Verification handshake: echo hub.challenge only when the verify token matches.
      if (req.method === 'GET') {
        const q = url.searchParams;
        const ok = q.get('hub.mode') === 'subscribe' && safeEqual(q.get('hub.verify_token') ?? '', verifyToken);
        return ok ? send(res, 200, q.get('hub.challenge') ?? '') : send(res, 403, 'Forbidden');
      }
      if (req.method !== 'POST') return send(res, 405, 'Method not allowed');

      const raw = await readBody(req);
      if (raw === 'too_large') return send(res, 413, 'Payload too large');

      // Authenticate before parsing: nothing in the body is trusted until the signature checks out.
      const signature = req.headers['x-hub-signature-256'];
      if (!verifySignature(raw, Array.isArray(signature) ? signature[0] : signature, appSecret)) {
        log('rejected webhook: bad or missing signature');
        return send(res, 401, 'Invalid signature');
      }

      let json: unknown;
      try {
        json = JSON.parse(raw.toString('utf8'));
      } catch {
        json = undefined;
      }
      const parsed = WebhookPayloadSchema.safeParse(json);
      if (!parsed.success) {
        // Signed by Meta but not a shape we handle: acknowledge, or it would be retried for days.
        log('acknowledged a signed webhook with an unexpected shape');
        return send(res, 200, 'ignored');
      }

      const result = await assistant.handleWebhook(parsed.data);
      // A non-200 asks Meta to redeliver; already-answered messages in the batch are skipped as duplicates.
      return result.retryable ? send(res, 500, 'retry') : send(res, 200, 'ok');
    } catch (err) {
      log(`unexpected error: ${err instanceof Error ? err.message : err}`);
      if (!res.headersSent) send(res, 500, 'error');
    }
  });
}
