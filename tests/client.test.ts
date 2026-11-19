import { describe, expect, it, vi } from 'vitest';
import { CloudApiWhatsAppClient } from '../src/client.js';

const opts = { accessToken: 'test-token', phoneNumberId: '111222333', graphApiVersion: 'v27.0' };
const okResponse = () => new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.abc' }] }), { status: 200 });

// These tests check the request this client builds. They do not call Meta.
describe('CloudApiWhatsAppClient (stubbed fetch)', () => {
  it('posts a text message to /{version}/{phone-number-id}/messages with a bearer token', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const client = new CloudApiWhatsAppClient({ ...opts, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.sendText({ to: '15550001111' }, 'Hello')).toEqual({ messageId: 'wamid.abc' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v27.0/111222333/messages');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15550001111',
      type: 'text',
      text: { preview_url: false, body: 'Hello' }
    });
  });

  it('uses `recipient` instead of `to` for a user id', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    await new CloudApiWhatsAppClient({ ...opts, fetchImpl: fetchImpl as unknown as typeof fetch }).sendText({ recipient: 'US.123' }, 'Hi');
    const sent = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.recipient).toBe('US.123');
    expect(sent).not.toHaveProperty('to');
  });

  it('throws with the status and API message on an error response, without the token', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'Invalid parameter', code: 100 } }), { status: 400 });
    const client = new CloudApiWhatsAppClient({ ...opts, fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await client.sendText({ to: '1' }, 'x').catch((e: Error) => e);
    expect((err as Error).message).toBe('Graph API responded 400: Invalid parameter');
    expect((err as Error).message).not.toContain('test-token');
  });

  it('throws when a 200 response has no message id', async () => {
    const fetchImpl = async () => new Response('{}', { status: 200 });
    const client = new CloudApiWhatsAppClient({ ...opts, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.sendText({ to: '1' }, 'x')).rejects.toThrow(/did not include a message id/);
  });

  it('still throws a clean status-only error when the error body is not JSON', async () => {
    const fetchImpl = async () => new Response('<html>Bad Gateway</html>', { status: 502 });
    const client = new CloudApiWhatsAppClient({ ...opts, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.sendText({ to: '1' }, 'x')).rejects.toThrow(/^Graph API responded 502$/);
  });
});
