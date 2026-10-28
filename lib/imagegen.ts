import "server-only";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getKv, setKv } from "./db";
import { addImageBuffer, imageMarkdown } from "./images";

/**
 * 自己画图给对方看：走本机已有的 gpt-image-2 脚本（~/.agents/skills/gptimg）。
 * 一张两分钱左右，所以要卡着：一次回复最多一张，一小时最多 4 张，一天最多 12 张。
 */
const run = promisify(execFile);
const SCRIPT = path.join(os.homedir(), ".agents", "skills", "gptimg", "scripts", "gptimg.mjs");
const TIMEOUT_MS = 5 * 60_000;

const PER_TURN = 1;
const PER_HOUR = 4;
const PER_DAY = 12;

const turns = ((globalThis as unknown as { __dongniImageTurns?: Map<string, number> }).__dongniImageTurns ??= new Map<string, number>());

export type GenOutcome = { ok: true; markdown: string } | { ok: false; message: string };

const stamp = (d: Date) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

/** 计数存在 kv 里：重启不清零，也不会跨小时/跨天累积 */
function counter(key: string, bucket: string, max: number) {
  const raw = getKv(key);
  const [was, n] = (raw ?? "").split(":");
  const count = was === bucket ? Number(n) || 0 : 0;
  return { count, full: count >= max, bump: () => setKv(key, `${bucket}:${count + 1}`) };
}

function budget() {
  const now = new Date();
  const hour = stamp(now) + String(now.getHours()).padStart(2, "0");
  return [counter("img_gen_hour", hour, PER_HOUR), counter("img_gen_day", stamp(now), PER_DAY)];
}

export async function generateImage(prompt: string, turnId: string): Promise<GenOutcome> {
  const p = prompt.trim();
  if (!p) return { ok: false, message: "没说要画什么，先问清一句再画。" };
  if ((turns.get(turnId) ?? 0) >= PER_TURN) return { ok: false, message: "这次已经画过一张了，别接着画，说完话就行。" };
  const [hour, day] = budget();
  if (hour.full || day.full) return { ok: false, message: "这会儿画的有点多了，过一阵再画；先跟对方说说想要什么样。" };

  const out = path.join(os.tmpdir(), `dongni-gen-${crypto.randomUUID()}.png`);
  try {
    const { stdout } = await run(
      process.execPath,
      [SCRIPT, p, "-o", out, "--size", "1024x1024", "--quality", "medium", "--json"],
      { timeout: TIMEOUT_MS, maxBuffer: 20 << 20 },
    );
    const info = JSON.parse(stdout.trim()) as { files?: string[] };
    const file = info.files?.[0];
    if (!file) throw new Error("没有产出图片");
    const buf = fs.readFileSync(file);
    fs.rmSync(file, { force: true });
    const rec = addImageBuffer(buf, "image/png", "gen", p);
    turns.set(turnId, (turns.get(turnId) ?? 0) + 1);
    hour.bump();
    day.bump();
    console.log(`[dongni] 画好一张图 #${rec.id}`);
    return { ok: true, markdown: imageMarkdown(rec.id) };
  } catch (e) {
    console.warn("[dongni] 画图失败：", e instanceof Error ? e.message : e);
    return { ok: false, message: "图没画出来（那边没响应），说一句大白话说没成，别贴报错。" };
  } finally {
    fs.rmSync(out, { force: true });
  }
}