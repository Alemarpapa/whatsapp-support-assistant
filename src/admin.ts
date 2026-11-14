import { SupportAssistant } from './assistant.js';
import { MockWhatsAppClient } from './client.js';
import { ConversationStore } from './store.js';

// Small operator tool: see which chats are with a person, and give one back to the bot.
const [command, userKey] = process.argv.slice(2);
const store = new ConversationStore(process.env.DB_PATH ?? 'data/assistant.sqlite');
try {
  if (command === 'list') {
    const rows = store.listConversations();
    if (!rows.length) console.log('No conversations yet.');
    for (const c of rows) console.log(`${c.userKey}  mode=${c.mode}  reason=${c.handoffReason ?? '-'}  updated=${c.updatedAt}`);
  } else if (command === 'release' && userKey) {
    const assistant = new SupportAssistant(store, new MockWhatsAppClient(), '');
    console.log(assistant.releaseToBot(userKey) ? `${userKey} is back with the bot.` : `${userKey} is not in human mode; nothing changed.`);
  } else {
    console.log('Usage: npm run admin -- list | release <wa_id>');
    process.exitCode = 1;
  }
} finally {
  store.close();
}
