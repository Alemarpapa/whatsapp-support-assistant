/** Either a phone number (`to`) or a business-scoped user id (`recipient`), as the Cloud API accepts. */
export type Recipient = { to: string } | { recipient: string };

export interface WhatsAppClient {
  /** Sends a text message and returns the id the API assigned to it. */
  sendText(recipient: Recipient, body: string): Promise<{ messageId: string }>;
}

/** Test double and local-demo client: records what would have been sent, calls nothing. */
export class MockWhatsAppClient implements WhatsAppClient {
  readonly sent: Array<{ recipient: Recipient; body: string; messageId: string }> = [];
  /** Set to make the next sends fail, to exercise error paths. */
  failNext = 0;

  constructor(private readonly onSend?: (recipient: Recipient, body: string) => void) {}

  async sendText(recipient: Recipient, body: string): Promise<{ messageId: string }> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('mock send failure');
    }
    const messageId = `wamid.mock-${this.sent.length + 1}`;
    this.sent.push({ recipient, body, messageId });
    this.onSend?.(recipient, body);
    return { messageId };
  }
}

export interface CloudApiOptions {
  accessToken: string;
  phoneNumberId: string;
  graphApiVersion: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Client for POST /{phone-number-id}/messages on the Graph API.
 * Request shape follows Meta's "send messages" guide; it is unit-tested against a stubbed fetch only.
 */
export class CloudApiWhatsAppClient implements WhatsAppClient {
  constructor(private readonly opts: CloudApiOptions) {}

  async sendText(recipient: Recipient, body: string): Promise<{ messageId: string }> {
    const { accessToken, phoneNumberId, graphApiVersion } = this.opts;
    const url = `${this.opts.baseUrl ?? 'https://graph.facebook.com'}/${graphApiVersion}/${phoneNumberId}/messages`;
    const res = await (this.opts.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        ...recipient,
        type: 'text',
        text: { preview_url: false, body }
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000)
    });
    // The error body can echo request details; keep only the status and Meta's error message.
    if (!res.ok) {
      const detail = await res.json().then((j) => (j as { error?: { message?: string } })?.error?.message, () => undefined);
      throw new Error(`Graph API responded ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const json = (await res.json()) as { messages?: Array<{ id?: string }> };
    const messageId = json.messages?.[0]?.id;
    if (!messageId) throw new Error('Graph API response did not include a message id');
    return { messageId };
  }
}
