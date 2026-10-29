import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 换电脑能直接用：外部依赖都优先找「随包带来的」，找不到再用这台电脑上原来的位置。
 * - 生图脚本：<项目>/vendor/gptimg（打包时连同 .env 一起带上） → ~/.agents/skills/gptimg
 * - 大模型线路：<项目>/config/llm.json（打包时从 pi 配置导出） → ~/.pi/agent
 */
const ROOT = process.cwd();

export function gptimgDir() {
  const bundled = path.join(ROOT, "vendor", "gptimg");
  if (fs.existsSync(path.join(bundled, "scripts", "gptimg.mjs"))) return bundled;
  return path.join(os.homedir(), ".agents", "skills", "gptimg");
}

export const gptimgScript = () => path.join(gptimgDir(), "scripts", "gptimg.mjs");

export const LLM_CONFIG = path.join(ROOT, "config", "llm.json");
