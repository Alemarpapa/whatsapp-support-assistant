import type { WebhookPayload } from '../src/schemas.js';

export const PHONE_ID = '111222333';
export const SECRET = 'test-app-secret';
export const VERIFY = 'test-verify-token';

let seq = 0;
export const nextId = () => `wamid.test-${++seq}`;

function envelope(field: string, value: Record<string, unknown>, phoneNumberId = PHONE_ID): WebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: '0', changes: [{ field, value: { metadata: { phone_number_id: phoneNumberId }, ...value } }] }]
  } as WebhookPayload;
}

export function textMessage(body: string, opts: { from?: string; id?: string; phoneNumberId?: string } = {}): WebhookPayload {
  return envelope(
    'messages',
    { messages: [{ from: opts.from ?? '15550001111', id: opts.id ?? nextId(), timestamp: '1773144000', type: 'text', text: { body } }] },
    opts.phoneNumberId
  );
}

export function rawMessages(messages: unknown[]): WebhookPayload {
  return envelope('messages', { messages });
}

export function echo(to = '15550001111', id = nextId()): WebhookPayload {
  return envelope('smb_message_echoes', {
    message_echoes: [{ from: '15550009999', to, id, timestamp: '1773144000', type: 'text', text: { body: 'A person here' } }]
  });
}
