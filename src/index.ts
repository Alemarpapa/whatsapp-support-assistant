import { SupportAssistant, mask } from './assistant.js';
import { CloudApiWhatsAppClient, MockWhatsAppClient, type WhatsAppClient } from './client.js';
import { loadConfig } from './schemas.js';
import { createWebhookServer } from './server.js';
import { ConversationStore } from './store.js';

const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

try {
  const config = loadConfig();
  const store = new ConversationStore(config.DB_PATH);
  const client: WhatsAppClient =
    config.OUTBOUND_MODE === 'cloud'
      ? new CloudApiWhatsAppClient({
          accessToken: config.WHATSAPP_ACCESS_TOKEN!,
          phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
          graphApiVersion: config.GRAPH_API_VERSION
        })
      : new MockWhatsAppClient((recipient, body) =>
          log(`[mock send] to ${mask('to' in recipient ? recipient.to : recipient.recipient)}: ${body}`)
        );

  const assistant = new SupportAssistant(store, client, config.WHATSAPP_PHONE_NUMBER_ID, log);
  const server = createWebhookServer({
    appSecret: config.WHATSAPP_APP_SECRET,
    verifyToken: config.WHATSAPP_VERIFY_TOKEN,
    assistant,
    log
  });
  server.listen(config.PORT, () => log(`webhook listening on :${config.PORT}/webhook (outbound: ${config.OUTBOUND_MODE})`));

  const shutdown = () => server.close(() => store.close());
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
