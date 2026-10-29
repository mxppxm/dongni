import "server-only";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { addImageBuffer, imageMarkdown } from "./images";

/**
 * 自己画图给对方看：走本机已有的 gpt-image-2 脚本（~/.agents/skills/gptimg）。
 * 一张两分钱左右。不限次数（对方明确说不要给她加限制）。
 *
 * 画不出来时把真实原因（脚本、接口的原话）交给模型，同时写进日志。
 * 以前这里一律只说「那边没响应」，模型只好自己编理由，编出过「我手里没那个画图工具」——
 * 记忆里却记着「生图没问题」，两边对不上，全靠嘴解释。
 */
const run = promisify(execFile);
const SKILL_DIR = path.join(os.homedir(), ".agents", "skills", "gptimg");
const SCRIPT = path.join(SKILL_DIR, "scripts", "gptimg.mjs");
const TIMEOUT_MS = 5 * 60_000;

export type GenOutcome = { ok: true; markdown: string } | { ok: false; message: string };

/** key 在 skill 目录的 .env 里（也可能在环境变量里）：缺了先照实说，别等脚本跑一半才失败 */
function notInstalled(): string | null {
  if (!fs.existsSync(SCRIPT)) return `生图脚本没装（找不到 ${SCRIPT}）`;
  if (process.env.GPTIMG_API_KEY?.trim()) return null;
  try {
    if (/^\s*GPTIMG_API_KEY\s*=\s*\S/m.test(fs.readFileSync(path.join(SKILL_DIR, ".env"), "utf8"))) return null;
  } catch {
    // 没有 .env 也算没配
  }
  return "生图用的 key 没配（skill 的 .env 里没有 GPTIMG_API_KEY）";
}

/** 脚本的报错原话在 stderr 里，e.message 只有一行 Command failed，看不出毛病 */
function whyFailed(e: unknown) {
  const err = e as { stderr?: string; message?: string; killed?: boolean; signal?: string };
  if (err.killed || err.signal) return `画图卡住了（${Math.round(TIMEOUT_MS / 60_000)} 分钟没画完）`;
  const lines = String(err.stderr ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = (lines.pop() ?? err.message ?? "").replace(/^gptimg:\s*/, "").replace(/\s+/g, " ").trim();
  return last.slice(0, 160) || "不知道什么原因";
}

export async function generateImage(prompt: string): Promise<GenOutcome> {
  const p = prompt.trim();
  if (!p) return { ok: false, message: "没说要画什么，先问清一句再画。" };
  const missing = notInstalled();
  if (missing) {
    console.error(`[dongni] 画不了：${missing}`);
    return { ok: false, message: `画不了，真实原因是：${missing}。跟他用大白话说这个原因，别说成「我不愿意画」或者别的。` };
  }

  const out = path.join(os.tmpdir(), `dongni-gen-${crypto.randomUUID()}.png`);
  try {
    const { stdout } = await run(
      process.execPath,
      [SCRIPT, p, "-o", out, "--size", "1024x1024", "--quality", "medium", "--json"],
      { timeout: TIMEOUT_MS, maxBuffer: 20 << 20 },
    );
    const info = JSON.parse(stdout.trim()) as { files?: string[] };
    const file = info.files?.[0];
    if (!file) throw new Error("脚本跑完了，但没产出图片文件");
    const buf = fs.readFileSync(file);
    fs.rmSync(file, { force: true });
    const rec = addImageBuffer(buf, "image/png", "gen", p);
    console.log(`[dongni] 画好一张图 #${rec.id}`);
    return { ok: true, markdown: imageMarkdown(rec.id) };
  } catch (e) {
    const why = whyFailed(e);
    console.warn(`[dongni] 画图失败：${why}`);
    return {
      ok: false,
      message: `图没画出来，真实原因是：${why}。跟他用大白话说这个原因（别提路径、别贴代码），别说自己手里没有画图工具。`,
    };
  } finally {
    fs.rmSync(out, { force: true });
  }
}