import type { Recipient, WhatsAppClient } from './client.js';
import { HANDOFF_NOTICE, MAX_UNKNOWN_STREAK, REPLIES, detectIntent } from './intents.js';
import { InboundMessageSchema, MessageEchoSchema, type WebhookPayload } from './schemas.js';
import type { ConversationStore } from './store.js';

export type Outcome =
  | 'replied'
  | 'handed_off'
  | 'silent_human_mode'
  | 'duplicate'
  | 'invalid'
  | 'send_failed'
  | 'echo_handoff'
  | 'echo_ignored';

export interface HandleResult {
  outcomes: Outcome[];
  /** True when at least one message could not be answered; the webhook should not return 200. */
  retryable: boolean;
}

/** Last 4 characters only, so logs do not carry full phone numbers. */
export const mask = (userKey: string) => `…${userKey.slice(-4)}`;

export class SupportAssistant {
  constructor(
    private readonly store: ConversationStore,
    private readonly client: WhatsAppClient,
    private readonly phoneNumberId: string,
    private readonly log: (line: string) => void = () => {}
  ) {}

  async handleWebhook(payload: WebhookPayload): Promise<HandleResult> {
    const outcomes: Outcome[] = [];
    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        // A webhook URL can receive events for several numbers; only act on the configured one.
        if (change.value.metadata?.phone_number_id !== this.phoneNumberId) continue;
        if (change.field === 'messages') {
          for (const raw of change.value.messages ?? []) outcomes.push(await this.handleInbound(raw));
        } else if (change.field === 'smb_message_echoes') {
          for (const raw of change.value.message_echoes ?? []) outcomes.push(this.handleEcho(raw));
        }
        // Everything else (statuses, history, account updates...) is acknowledged and ignored.
      }
    }
    return { outcomes, retryable: outcomes.includes('send_failed') };
  }

  private async handleInbound(raw: unknown): Promise<Outcome> {
    const parsed = InboundMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.log('skipped a message that does not match the expected shape');
      return 'invalid';
    }
    const msg = parsed.data;
    const userKey = (msg.from ?? msg.from_user_id)!;
    const recipient: Recipient = msg.from ? { to: msg.from } : { recipient: msg.from_user_id! };

    // Idempotency: Meta retries and can deliver the same message more than once.
    if (!this.store.claimInbound(msg.id, userKey)) return 'duplicate';

    try {
      const convo = this.store.getConversation(userKey);
      if (convo.mode === 'human') {
        this.store.completeInbound(msg.id, 'silent_human_mode');
        return 'silent_human_mode';
      }

      const intent = msg.type === 'text' && msg.text ? detectIntent(msg.text.body) : 'unknown';
      const streak = intent === 'unknown' ? convo.unknownStreak + 1 : 0;
      const handoffReason = intent === 'human' ? 'customer_request' : streak >= MAX_UNKNOWN_STREAK ? 'not_understood' : null;

      // Send first, change state after: if the send fails nothing is half-applied and the retry redoes it all.
      const { messageId } = await this.client.sendText(recipient, handoffReason ? HANDOFF_NOTICE : REPLIES[intent as keyof typeof REPLIES]);
      this.store.recordOutbound(messageId, userKey);
      // A person may have taken over while the send was in flight: saveBotProgress never overwrites human mode.
      if (handoffReason) this.store.saveConversation(userKey, 'human', 0, handoffReason);
      else this.store.saveBotProgress(userKey, streak);
      const outcome: Outcome = handoffReason ? 'handed_off' : 'replied';
      this.store.completeInbound(msg.id, outcome);
      this.log(`${mask(userKey)} intent=${intent} -> ${outcome}${handoffReason ? ` (${handoffReason})` : ''}`);
      return outcome;
    } catch (err) {
      this.store.releaseInbound(msg.id);
      this.log(`${mask(userKey)} send failed: ${err instanceof Error ? err.message : err}`);
      return 'send_failed';
    }
  }

  /**
   * Coexistence: a person answered from the WhatsApp Business app. That is a human taking over,
   * so the bot goes quiet for that conversation.
   */
  private handleEcho(raw: unknown): Outcome {
    const parsed = MessageEchoSchema.safeParse(raw);
    if (!parsed.success) return 'invalid';
    const echo = parsed.data;
    // Defensive: never treat one of our own API messages as a human reply.
    if (this.store.isOwnOutbound(echo.id)) return 'echo_ignored';
    const userKey = (echo.to ?? echo.to_user_id)!;
    if (this.store.getConversation(userKey).mode === 'human') return 'echo_ignored';
    this.store.saveConversation(userKey, 'human', 0, 'human_replied_from_app');
    this.log(`${mask(userKey)} human replied from the Business app -> bot silenced`);
    return 'echo_handoff';
  }

  /** Gives a conversation back to the bot. Returns false if it was not in human mode. */
  releaseToBot(userKey: string): boolean {
    if (this.store.getConversation(userKey).mode !== 'human') return false;
    this.store.saveConversation(userKey, 'bot', 0, null);
    return true;
  }
}
