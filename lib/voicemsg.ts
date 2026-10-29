import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, getKv, setKv, type MessageRow } from "./db";
import { doubaoTts, ttsReady } from "./doubao";
import { speakableText, synthesizeFallback } from "./tts";

/**
 * 对话里的语音消息：音频存本地，库里留一条索引；正文里用 `![语音](/api/voice/clip/<编号>)` 引用，
 * 前端认这个地址就画成一个小播放器（不是图片）。跟图片一个路子，消息本身还是原来那张表。
 */
const DATA_DIR = process.env.DONGNI_DATA_DIR || path.join(process.cwd(), "data");
const CLIP_DIR = path.join(DATA_DIR, "audio", "voice");

export type VoiceClipRec = {
  id: number;
  file: string;
  mime: string;
  seconds: number;
  text: string;
  kind: string;
  created_at: number;
};

const g = globalThis as unknown as { __dongniVoiceReady?: boolean };

function table() {
  if (g.__dongniVoiceReady) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS voice_clips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file TEXT NOT NULL,
      mime TEXT NOT NULL,
      seconds REAL NOT NULL DEFAULT 0,
      text TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'in',
      created_at INTEGER NOT NULL
    );
  `);
  g.__dongniVoiceReady = true;
}

export function saveVoiceClip(input: { buf: Buffer; mime: string; seconds?: number; text?: string; kind: "in" | "out" }): VoiceClipRec {
  table();
  fs.mkdirSync(CLIP_DIR, { recursive: true });
  const ext = input.mime === "audio/mpeg" ? ".mp3" : input.mime === "audio/ogg" ? ".ogg" : ".wav";
  const file = `clip-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  fs.writeFileSync(path.join(CLIP_DIR, file), input.buf);
  const now = Date.now();
  const id = Number(
    db()
      .prepare("INSERT INTO voice_clips(file, mime, seconds, text, kind, created_at) VALUES(?, ?, ?, ?, ?, ?)")
      .run(file, input.mime, Math.max(0, Math.round((input.seconds ?? 0) * 10) / 10), input.text ?? "", input.kind, now).lastInsertRowid,
  );
  return { id, file, mime: input.mime, seconds: input.seconds ?? 0, text: input.text ?? "", kind: input.kind, created_at: now };
}

export function getVoiceClip(id: number): VoiceClipRec | null {
  if (!Number.isFinite(id)) return null;
  table();
  return (db().prepare("SELECT * FROM voice_clips WHERE id = ?").get(id) as VoiceClipRec | undefined) ?? null;
}

export const voiceClipPath = (rec: VoiceClipRec) => path.join(CLIP_DIR, rec.file);

export const voiceMarkdown = (id: number) => `![语音](/api/voice/clip/${id})`;

/** 正文里的语音编号 */
export function voiceIdsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/!\[[^\]]*\]\(\/api\/voice\/clip\/(\d+)\)/g)) {
    const id = Number(m[1]);
    if (Number.isInteger(id) && id > 0 && !out.includes(id)) out.push(id);
  }
  return out;
}

export function setClipText(id: number, text: string) {
  table();
  db().prepare("UPDATE voice_clips SET text = ? WHERE id = ?").run(text, id);
}

export const publicMessage = (m: MessageRow) => ({
  id: m.id,
  clientId: m.client_id,
  role: m.role,
  content: m.content,
  status: m.status,
  createdAt: m.created_at,
  kind: m.kind ?? "chat",
});

/** 他发来的语音落成一条对话记录（同一个 clientId 重发时改那条，不重复插） */
export function putUserVoiceMessage(clientId: string, content: string): MessageRow {
  const d = db();
  const existed = d.prepare("SELECT * FROM messages WHERE client_id = ?").get(clientId) as MessageRow | undefined;
  if (existed) {
    d.prepare("UPDATE messages SET content = ?, status = 'done' WHERE id = ?").run(content, existed.id);
    return { ...existed, content, status: "done" };
  }
  const id = Number(
    d
      .prepare("INSERT INTO messages(client_id, role, content, status, created_at) VALUES(?, 'user', ?, 'done', ?)")
      .run(clientId, content, Date.now()).lastInsertRowid,
  );
  return d.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow;
}

/** 她说一句话（不等模型，直接落库）：要 key、没听清这类必须有回应的场合用它 */
export function sayNow(content: string): MessageRow {
  const id = Number(
    db()
      .prepare("INSERT INTO messages(role, content, status, extracted, created_at, kind) VALUES('assistant', ?, 'done', 0, ?, 'chat')")
      .run(content, Date.now()).lastInsertRowid,
  );
  return db().prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow;
}

const ASK_AT = "voice:ask-at";

/**
 * 他要发语音、但还没配豆包凭据：用她的话把缺的东西要过来。
 * 10 分钟内已经要过一次就换个更短的句子，不重复念同一段。
 */
export function askForKey(): MessageRow {
  const last = Number(getKv(ASK_AT) || 0);
  const again = Date.now() - last < 10 * 60_000;
  const text = again
    ? "还是那两样——火山引擎豆包语音的 APP ID 和 Access Token（新版控制台的 API Key 也行），你贴过来我就能听了。"
    : "我这边的耳朵还没接上：你去火山引擎的豆包语音控制台拿一下 APP ID 和 Access Token（新版控制台的 API Key 也行），发我一句，我自己存好，就能听你说话了。";
  setKv(ASK_AT, String(Date.now()));
  return sayNow(text);
}

/** 没听清（音频太轻、没识别出字）时的一句实话 */
export function sayNotHeard(): MessageRow {
  return sayNow("刚那段我没听清，你再说一遍呀。");
}

/**
 * 她回答完一条语音消息：把回复也做成一条语音接在后面。
 * 合成慢一点没关系，文字已经在那儿了；失败就当没这回事，回复照旧。
 */
export async function attachVoiceReply(assistantId: number, content: string): Promise<{ markdown: string; content: string } | null> {
  if (!ttsReady()) return null;
  if (voiceIdsIn(content).length) return null;
  const said = speakableText(content);
  if (!said) return null;

  // 豆包合成失败就退回原来的 edge-tts——声音可以不一样，但这条语音不能没声
  let audio: { buf: Buffer; mime: string } | null = null;
  const got = await doubaoTts(said);
  if (got) audio = { buf: got.audio, mime: got.mime };
  if (!audio) {
    try {
      const file = await synthesizeFallback(said);
      if (file) audio = { buf: fs.readFileSync(file), mime: "audio/mpeg" };
    } catch (e) {
      console.warn("[dongni] 语音回复退回 edge-tts 也没成：", e instanceof Error ? e.message : e);
    }
  }
  if (!audio) return null;

  const rec = saveVoiceClip({ buf: audio.buf, mime: audio.mime, text: said, kind: "out", seconds: Math.max(1, Math.round(said.length / 5)) });
  const next = `${content.trim()}\n\n${voiceMarkdown(rec.id)}`;
  db().prepare("UPDATE messages SET content = ? WHERE id = ?").run(next, assistantId);
  return { markdown: voiceMarkdown(rec.id), content: next };
}