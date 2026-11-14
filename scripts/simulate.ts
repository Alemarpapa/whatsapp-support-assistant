// Local simulator: builds a webhook notification shaped like Meta's, signs it with your app secret
// and POSTs it to the local server. It lets you exercise the whole flow without a Meta account.
// It does NOT prove that real Meta payloads or signatures are accepted.
import { parseArgs } from 'node:util';
import { signPayload } from '../src/signature.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: 'string', default: '15550001111' },
    id: { type: 'string' }, // reuse an id to simulate a duplicate delivery
    echo: { type: 'boolean', default: false }, // a human reply sent from the Business app (coexistence)
    'bad-signature': { type: 'boolean', default: false },
    url: { type: 'string', default: `http://localhost:${process.env.PORT ?? 3000}/webhook` }
  }
});

const secret = process.env.WHATSAPP_APP_SECRET;
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
if (!secret || !phoneNumberId) {
  console.error('Set WHATSAPP_APP_SECRET and WHATSAPP_PHONE_NUMBER_ID (see .env.example).');
  process.exit(1);
}

const text = positionals.join(' ') || 'hello';
const id = values.id ?? `wamid.sim-${Date.now()}`;
const timestamp = String(Math.floor(Date.now() / 1000));
const metadata = { display_phone_number: '15550009999', phone_number_id: phoneNumberId };

const value = values.echo
  ? {
      messaging_product: 'whatsapp',
      metadata,
      message_echoes: [{ from: metadata.display_phone_number, to: values.from, id, timestamp, type: 'text', text: { body: text } }]
    }
  : {
      messaging_product: 'whatsapp',
      metadata,
      contacts: [{ profile: { name: 'Simulated User' }, wa_id: values.from }],
      messages: [{ from: values.from, id, timestamp, type: 'text', text: { body: text } }]
    };

const body = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: '0', changes: [{ field: values.echo ? 'smb_message_echoes' : 'messages', value }] }]
});

const res = await fetch(values.url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Hub-Signature-256': values['bad-signature'] ? 'sha256=' + '0'.repeat(64) : signPayload(body, secret)
  },
  body
});
console.log(`${values.echo ? 'echo' : 'message'} id=${id} -> HTTP ${res.status} ${await res.text()}`);
