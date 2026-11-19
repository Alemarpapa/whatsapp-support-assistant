import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SupportAssistant } from '../src/assistant.js';
import { MockWhatsAppClient } from '../src/client.js';
import { HANDOFF_NOTICE, REPLIES } from '../src/intents.js';
import { ConversationStore } from '../src/store.js';
import { PHONE_ID, echo, rawMessages, textMessage } from './helpers.js';

let store: ConversationStore;
let client: MockWhatsAppClient;
let assistant: SupportAssistant;
const USER = '15550001111';

beforeEach(() => {
  store = new ConversationStore();
  client = new MockWhatsAppClient();
  assistant = new SupportAssistant(store, client, PHONE_ID);
});

describe('replies', () => {
  it('answers a known intent to the sender', async () => {
    const res = await assistant.handleWebhook(textMessage('what are your hours?'));
    expect(res).toEqual({ outcomes: ['replied'], retryable: false });
    expect(client.sent).toMatchObject([{ recipient: { to: USER }, body: REPLIES.hours }]);
  });

  it('addresses users without a phone number by their user id', async () => {
    await assistant.handleWebhook(rawMessages([{ from_user_id: 'US.123', id: 'wamid.u1', type: 'text', text: { body: 'hi' } }]));
    expect(client.sent[0].recipient).toEqual({ recipient: 'US.123' });
  });

  it('ignores events for a different phone number id', async () => {
    const res = await assistant.handleWebhook(textMessage('hi', { phoneNumberId: '999' }));
    expect(res.outcomes).toEqual([]);
    expect(client.sent).toHaveLength(0);
  });

  it('skips malformed messages but still handles valid ones in the same batch', async () => {
    const res = await assistant.handleWebhook(
      rawMessages([{ id: 'no-sender', type: 'text' }, 'garbage', { from: USER, id: 'wamid.ok', type: 'text', text: { body: 'hello' } }])
    );
    expect(res.outcomes).toEqual(['invalid', 'invalid', 'replied']);
  });

  it('treats non-text messages as not understood instead of crashing', async () => {
    const res = await assistant.handleWebhook(rawMessages([{ from: USER, id: 'wamid.a1', type: 'audio' }]));
    expect(res.outcomes).toEqual(['replied']);
    expect(client.sent[0].body).toBe(REPLIES.unknown);
  });
});

describe('guardrails', () => {
  it('rejects a text body over the 8192-character limit without replying', async () => {
    const res = await assistant.handleWebhook(textMessage('a'.repeat(8193)));
    expect(res.outcomes).toEqual(['invalid']);
    expect(client.sent).toHaveLength(0);
    expect(store.getConversation(USER).unknownStreak).toBe(0);
  });
});

describe('idempotency', () => {
  it('answers a redelivered message id only once', async () => {
    const payload = textMessage('hello', { id: 'wamid.dup' });
    await assistant.handleWebhook(payload);
    const again = await assistant.handleWebhook(payload);
    expect(again.outcomes).toEqual(['duplicate']);
    expect(client.sent).toHaveLength(1);
  });

  it('answers once when the same message arrives twice concurrently', async () => {
    const payload = textMessage('hello', { id: 'wamid.race' });
    const results = await Promise.all([assistant.handleWebhook(payload), assistant.handleWebhook(payload)]);
    expect(results.flatMap((r) => r.outcomes).sort()).toEqual(['duplicate', 'replied']);
    expect(client.sent).toHaveLength(1);
  });

  it('keeps dedup state across restarts (same database file)', async () => {
    const file = `/tmp/wa-test-${process.pid}-${Date.now()}.sqlite`;
    const first = new ConversationStore(file);
    await new SupportAssistant(first, client, PHONE_ID).handleWebhook(textMessage('hello', { id: 'wamid.persist' }));
    first.close();
    const second = new ConversationStore(file);
    const res = await new SupportAssistant(second, client, PHONE_ID).handleWebhook(textMessage('hello', { id: 'wamid.persist' }));
    second.close();
    expect(res.outcomes).toEqual(['duplicate']);
  });

  it('when sending fails: reports retryable, changes no state, and the retry is processed', async () => {
    const payload = textMessage('agent please', { id: 'wamid.fail' });
    client.failNext = 1;
    expect(await assistant.handleWebhook(payload)).toEqual({ outcomes: ['send_failed'], retryable: true });
    expect(store.getConversation(USER).mode).toBe('bot');

    expect((await assistant.handleWebhook(payload)).outcomes).toEqual(['handed_off']);
    expect(store.getConversation(USER).mode).toBe('human');
    expect(client.sent).toHaveLength(1);
  });
});

describe('batches and retries', () => {
  it('after a failed send in a batch, the retry answers only the message that failed', async () => {
    const payload = rawMessages([
      { from: USER, id: 'wamid.b1', type: 'text', text: { body: 'hours' } },
      { from: USER, id: 'wamid.b2', type: 'text', text: { body: 'address' } }
    ]);
    client.failNext = 1;
    expect(await assistant.handleWebhook(payload)).toEqual({ outcomes: ['send_failed', 'replied'], retryable: true });
    expect(await assistant.handleWebhook(payload)).toEqual({ outcomes: ['replied', 'duplicate'], retryable: false });
    expect(client.sent.map((s) => s.body)).toEqual([REPLIES.location, REPLIES.hours]);
  });
});

describe('handoff to a person', () => {
  it('hands off when the customer asks, then stays silent', async () => {
    expect((await assistant.handleWebhook(textMessage('I need a human'))).outcomes).toEqual(['handed_off']);
    expect(client.sent.map((s) => s.body)).toEqual([HANDOFF_NOTICE]);
    expect(store.getConversation(USER)).toMatchObject({ mode: 'human', handoffReason: 'customer_request' });

    const later = await assistant.handleWebhook(textMessage('what are your hours?'));
    expect(later.outcomes).toEqual(['silent_human_mode']);
    expect(client.sent).toHaveLength(1);
  });

  it('hands off after two messages in a row it does not understand', async () => {
    await assistant.handleWebhook(textMessage('my order arrived broken'));
    expect(store.getConversation(USER)).toMatchObject({ mode: 'bot', unknownStreak: 1 });
    const res = await assistant.handleWebhook(textMessage('it is the blue one'));
    expect(res.outcomes).toEqual(['handed_off']);
    expect(store.getConversation(USER)).toMatchObject({ mode: 'human', handoffReason: 'not_understood' });
  });

  it('resets the not-understood streak after an understood message', async () => {
    await assistant.handleWebhook(textMessage('blah'));
    await assistant.handleWebhook(textMessage('hours?'));
    await assistant.handleWebhook(textMessage('blah again'));
    expect(store.getConversation(USER)).toMatchObject({ mode: 'bot', unknownStreak: 1 });
  });

  it('keeps conversations independent: one customer in human mode does not silence another', async () => {
    await assistant.handleWebhook(textMessage('agent', { from: '15550002222' }));
    const res = await assistant.handleWebhook(textMessage('hello', { from: USER }));
    expect(res.outcomes).toEqual(['replied']);
  });

  it('after a release, the not-understood streak starts from zero', async () => {
    await assistant.handleWebhook(textMessage('blah'));
    await assistant.handleWebhook(textMessage('blah blah'));
    expect(store.getConversation(USER)).toMatchObject({ mode: 'human', handoffReason: 'not_understood' });
    assistant.releaseToBot(USER);
    expect(store.getConversation(USER)).toMatchObject({ mode: 'bot', unknownStreak: 0, handoffReason: null });
    expect((await assistant.handleWebhook(textMessage('blah once more'))).outcomes).toEqual(['replied']);
  });

  it('releases a conversation back to the bot', async () => {
    await assistant.handleWebhook(textMessage('agent'));
    expect(assistant.releaseToBot(USER)).toBe(true);
    expect(assistant.releaseToBot(USER)).toBe(false);
    expect((await assistant.handleWebhook(textMessage('hello'))).outcomes).toEqual(['replied']);
  });
});

describe('coexistence echoes (a person replies from the Business app)', () => {
  it('silences the bot for that conversation', async () => {
    expect((await assistant.handleWebhook(echo(USER))).outcomes).toEqual(['echo_handoff']);
    expect(store.getConversation(USER)).toMatchObject({ mode: 'human', handoffReason: 'human_replied_from_app' });
    expect((await assistant.handleWebhook(textMessage('hello'))).outcomes).toEqual(['silent_human_mode']);
    expect(client.sent).toHaveLength(0);
  });

  it('handles echoes addressed by user id, ignores malformed ones, and keeps the first takeover reason', async () => {
    const byUserId = (id: string) => ({
      object: 'whatsapp_business_account',
      entry: [{ id: '0', changes: [{ field: 'smb_message_echoes', value: { metadata: { phone_number_id: PHONE_ID }, message_echoes: [{ id, to_user_id: 'US.9' }, { id: 'no-recipient' }] } }] }]
    });
    const res = await assistant.handleWebhook(byUserId('wamid.e1') as never);
    expect(res.outcomes).toEqual(['echo_handoff', 'invalid']);
    expect(store.getConversation('US.9')).toMatchObject({ mode: 'human', handoffReason: 'human_replied_from_app' });

    await assistant.handleWebhook(textMessage('agent', { from: USER }));
    expect((await assistant.handleWebhook(echo(USER))).outcomes).toEqual(['echo_ignored']);
    expect(store.getConversation(USER).handoffReason).toBe('customer_request');
  });

  it('does not mistake an echo of its own API message for a person', async () => {
    await assistant.handleWebhook(textMessage('hello'));
    const res = await assistant.handleWebhook(echo(USER, client.sent[0].messageId));
    expect(res.outcomes).toEqual(['echo_ignored']);
    expect(store.getConversation(USER).mode).toBe('bot');
  });

  it('does not flip back to bot when a person takes over while a reply is being sent', async () => {
    const slow = new MockWhatsAppClient();
    const original = slow.sendText.bind(slow);
    slow.sendText = async (r, b) => {
      await assistant.handleWebhook(echo(USER)); // the human reply lands mid-send
      return original(r, b);
    };
    const racing = new SupportAssistant(store, slow, PHONE_ID);
    // 'unknown' intent: the bot's pending save would write mode=bot, streak=1.
    expect((await racing.handleWebhook(textMessage('asdf qwerty'))).outcomes).toEqual(['replied']);
    expect(store.getConversation(USER)).toMatchObject({ mode: 'human', unknownStreak: 0, handoffReason: 'human_replied_from_app' });
    // and the bot stays quiet afterwards
    expect((await racing.handleWebhook(textMessage('hello'))).outcomes).toEqual(['silent_human_mode']);
    expect(slow.sent).toHaveLength(1);
  });

  it('saveBotProgress never overwrites human mode, even from a second connection to the same database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-race-'));
    const file = path.join(dir, 'db.sqlite');
    const botSide = new ConversationStore(file);
    const humanSide = new ConversationStore(file);
    try {
      expect(botSide.saveBotProgress(USER, 1)).toBe(true);
      humanSide.saveConversation(USER, 'human', 0, 'human_replied_from_app');
      expect(botSide.saveBotProgress(USER, 2)).toBe(false);
      expect(humanSide.getConversation(USER)).toMatchObject({ mode: 'human', unknownStreak: 0, handoffReason: 'human_replied_from_app' });
    } finally {
      botSide.close();
      humanSide.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never stores message text', async () => {
    await assistant.handleWebhook(textMessage('my secret account number is 4242'));
    await assistant.handleWebhook(echo(USER));
    const dump = JSON.stringify(
      ['inbound_messages', 'outbound_messages', 'conversations'].map((t) => store.db.prepare(`SELECT * FROM ${t}`).all())
    );
    expect(dump).not.toContain('4242');
    expect(dump).not.toContain('A person here');
  });
});
