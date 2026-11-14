import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type Mode = 'bot' | 'human';

export interface Conversation {
  userKey: string;
  mode: Mode;
  unknownStreak: number;
  handoffReason: string | null;
  updatedAt: string;
}

/**
 * SQLite state: which messages were already handled, and who owns each conversation.
 * Message text is never stored, only ids and routing metadata.
 */
export class ConversationStore {
  readonly db: Database.Database;

  constructor(dbPath = ':memory:') {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbound_messages (
        message_id TEXT PRIMARY KEY,
        user_key TEXT NOT NULL,
        outcome TEXT,
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbound_messages (
        message_id TEXT PRIMARY KEY,
        user_key TEXT NOT NULL,
        sent_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        user_key TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'bot' CHECK(mode IN ('bot', 'human')),
        unknown_streak INTEGER NOT NULL DEFAULT 0,
        handoff_reason TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    // shortcut: ids are kept forever; Meta retries for up to 7 days, add a pruning job at real volume.
  }

  /** Claims a message id. False means it was already seen (a retry or duplicate delivery). */
  claimInbound(messageId: string, userKey: string): boolean {
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO inbound_messages (message_id, user_key, received_at) VALUES (?, ?, ?)')
        .run(messageId, userKey, new Date().toISOString()).changes === 1
    );
  }

  /** Gives the claim back after a failure so Meta's retry of the same message is processed again. */
  releaseInbound(messageId: string): void {
    this.db.prepare('DELETE FROM inbound_messages WHERE message_id = ? AND outcome IS NULL').run(messageId);
  }

  completeInbound(messageId: string, outcome: string): void {
    this.db.prepare('UPDATE inbound_messages SET outcome = ? WHERE message_id = ?').run(outcome, messageId);
  }

  recordOutbound(messageId: string, userKey: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO outbound_messages (message_id, user_key, sent_at) VALUES (?, ?, ?)')
      .run(messageId, userKey, new Date().toISOString());
  }

  isOwnOutbound(messageId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM outbound_messages WHERE message_id = ?').get(messageId);
  }

  getConversation(userKey: string): Conversation {
    const row = this.db.prepare('SELECT * FROM conversations WHERE user_key = ?').get(userKey) as
      | { user_key: string; mode: Mode; unknown_streak: number; handoff_reason: string | null; updated_at: string }
      | undefined;
    return row
      ? { userKey: row.user_key, mode: row.mode, unknownStreak: row.unknown_streak, handoffReason: row.handoff_reason, updatedAt: row.updated_at }
      : { userKey, mode: 'bot', unknownStreak: 0, handoffReason: null, updatedAt: new Date(0).toISOString() };
  }

  saveConversation(userKey: string, mode: Mode, unknownStreak: number, handoffReason: string | null): void {
    this.db
      .prepare(
        `INSERT INTO conversations (user_key, mode, unknown_streak, handoff_reason, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_key) DO UPDATE SET mode = excluded.mode, unknown_streak = excluded.unknown_streak,
           handoff_reason = excluded.handoff_reason, updated_at = excluded.updated_at`
      )
      .run(userKey, mode, unknownStreak, handoffReason, new Date().toISOString());
  }

  /**
   * Records the bot's own progress after a reply. One atomic statement that never touches a
   * conversation a person already owns, so a takeover that lands while a reply is in flight
   * (even from another process) cannot be overwritten. Returns false when a person owns it.
   */
  saveBotProgress(userKey: string, unknownStreak: number): boolean {
    return (
      this.db
        .prepare(
          `INSERT INTO conversations (user_key, mode, unknown_streak, handoff_reason, updated_at) VALUES (?, 'bot', ?, NULL, ?)
           ON CONFLICT(user_key) DO UPDATE SET unknown_streak = excluded.unknown_streak, updated_at = excluded.updated_at
           WHERE conversations.mode = 'bot'`
        )
        .run(userKey, unknownStreak, new Date().toISOString()).changes === 1
    );
  }

  listConversations(mode?: Mode): Conversation[] {
    const rows = this.db.prepare('SELECT user_key FROM conversations ORDER BY updated_at DESC').all() as Array<{ user_key: string }>;
    return rows.map((r) => this.getConversation(r.user_key)).filter((c) => !mode || c.mode === mode);
  }

  close(): void {
    this.db.close();
  }
}
