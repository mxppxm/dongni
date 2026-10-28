import "server-only";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DONGNI_DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "dongni.db");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const BACKUP_KEEP = 30;

export type MessageRow = {
  id: number;
  client_id: string | null;
  role: "user" | "assistant";
  content: string;
  status: "done" | "streaming" | "error";
  extracted: number;
  created_at: number;
};

export type MemoryRow = {
  id: number;
  content: string;
  category: string;
  source_message_id: number | null;
  created_at: number;
  updated_at: number;
};

export type LinkRow = { a: number; b: number; reason: string };

const g = globalThis as unknown as { __dongniDb?: Database.Database };

function open() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT UNIQUE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'done',
      extracted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages(role, extracted);

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT NOT NULL,
      source_message_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_links (
      a INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      b INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      reason TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (a, b)
    );

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export function db() {
  if (!g.__dongniDb) g.__dongniDb = open();
  return g.__dongniDb;
}

export function getKv(key: string): string | null {
  const row = db().prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setKv(key: string, value: string) {
  db().prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** 每天一份整库备份，保留最近 30 份 */
export async function backupDaily() {
  const day = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD
  const file = path.join(BACKUP_DIR, `dongni-${day}.db`);
  if (fs.existsSync(file)) return;
  await db().backup(file);
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith("dongni-") && f.endsWith(".db")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) fs.rmSync(path.join(BACKUP_DIR, f));
}
