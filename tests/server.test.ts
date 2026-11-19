import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SupportAssistant } from '../src/assistant.js';
import { MockWhatsAppClient } from '../src/client.js';
import { MAX_BODY_BYTES, createWebhookServer } from '../src/server.js';
import { signPayload } from '../src/signature.js';
import { ConversationStore } from '../src/store.js';
import { PHONE_ID, SECRET, VERIFY, textMessage } from './helpers.js';

let server: http.Server;
let base: string;
let client: MockWhatsAppClient;

beforeEach(async () => {
  client = new MockWhatsAppClient();
  const assistant = new SupportAssistant(new ConversationStore(), client, PHONE_ID);
  server = createWebhookServer({ appSecret: SECRET, verifyToken: VERIFY, assistant });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const post = (body: string, signature: string | null = signPayload(body, SECRET)) =>
  fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-Hub-Signature-256': signature } : {}) },
    body
  });

describe('GET /webhook verification handshake', () => {
  it('echoes hub.challenge when the verify token matches', async () => {
    const res = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('1158201444');
  });

  it.each([
    ['wrong token', `hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`],
    ['missing token', `hub.mode=subscribe&hub.challenge=1`],
    ['wrong mode', `hub.mode=unsubscribe&hub.verify_token=${VERIFY}&hub.challenge=1`]
  ])('responds 403 on %s and does not leak the challenge', async (_n, query) => {
    const res = await fetch(`${base}/webhook?${query}`);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Forbidden');
  });
});

describe('POST /webhook', () => {
  it('processes a correctly signed message', async () => {
    const res = await post(JSON.stringify(textMessage('hello')));
    expect(res.status).toBe(200);
    expect(client.sent).toHaveLength(1);
  });

  it('rejects a missing or wrong signature with 401 and processes nothing', async () => {
    const body = JSON.stringify(textMessage('hello'));
    expect((await post(body, null)).status).toBe(401);
    expect((await post(body, signPayload(body, 'attacker-secret'))).status).toBe(401);
    expect((await post(body, 'sha256=' + '0'.repeat(64))).status).toBe(401);
    expect(client.sent).toHaveLength(0);
  });

  it('rejects a tampered body even with a signature that was valid for the original', async () => {
    const body = JSON.stringify(textMessage('hello'));
    const res = await post(body.replace('hello', 'agent'), signPayload(body, SECRET));
    expect(res.status).toBe(401);
  });

  it('answers a redelivered webhook with 200 without replying twice', async () => {
    const body = JSON.stringify(textMessage('hello', { id: 'wamid.redelivered' }));
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(200);
    expect(client.sent).toHaveLength(1);
  });

  it('returns 500 when the reply cannot be sent, so the provider retries; the retry then succeeds', async () => {
    const body = JSON.stringify(textMessage('hello', { id: 'wamid.retry' }));
    client.failNext = 1;
    expect((await post(body)).status).toBe(500);
    expect((await post(body)).status).toBe(200);
    expect(client.sent).toHaveLength(1);
  });

  it('acknowledges signed payloads it does not understand (invalid JSON, other objects, status updates)', async () => {
    for (const body of [
      'not json',
      JSON.stringify({ object: 'page', entry: [] }),
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ id: '0', changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_ID }, statuses: [{ id: 'x', status: 'delivered' }] } }] }]
      })
    ]) {
      expect((await post(body)).status).toBe(200);
    }
    expect(client.sent).toHaveLength(0);
  });

  it('rejects bodies over the 3 MB limit with 413', async () => {
    const body = 'x'.repeat(MAX_BODY_BYTES + 1);
    expect((await post(body)).status).toBe(413);
  });

  it('accepts a signed body of exactly 3 MB and rejects one byte more with 413, even if signed', async () => {
    const json = JSON.stringify(textMessage('hello'));
    const padded = (size: number) => json + ' '.repeat(size - Buffer.byteLength(json));
    expect((await post(padded(MAX_BODY_BYTES))).status).toBe(200);
    expect(client.sent).toHaveLength(1);
    expect((await post(padded(MAX_BODY_BYTES + 1))).status).toBe(413);
    expect(client.sent).toHaveLength(1);
  });

  it('responds 404 for other paths and 405 for other methods', async () => {
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/webhook`, { method: 'DELETE' })).status).toBe(405);
  });
});
