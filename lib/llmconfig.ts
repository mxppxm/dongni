import "server-only";
import fs from "node:fs";
import { LLM_CONFIG } from "./portable";

/**
 * 模型线路的配置：config/llm.json（不进仓库，key 只在本机）。两种写法都认：
 * - 老的单条：{ baseUrl, apiKey, model }
 * - 多条可切：{ active: "company", profiles: { company: { label, baseUrl, apiKey, model, piModel? }, mine: {…} } }
 * 页面右上角菜单里切的就是 active；改完写回文件，llm.ts 按文件 mtime 自动换线路，不用重启。
 */
/** piModel：自我修复叫 pi 时用的「provider/模型」，跟着这条线路一起切；不写就用 pi 自己的默认 */
export type LlmProfile = { label?: string; baseUrl: string; apiKey: string; model: string; piModel?: string };
type MultiConfig = { active?: string; profiles: Record<string, LlmProfile> };
type FileConfig = LlmProfile | MultiConfig;

const isMulti = (c: FileConfig): c is MultiConfig => !!(c as MultiConfig).profiles;

export function hasLlmConfig() {
  return fs.existsSync(LLM_CONFIG);
}

export function llmConfigMtime() {
  return fs.statSync(LLM_CONFIG).mtimeMs;
}

function readConfig(): FileConfig {
  return JSON.parse(fs.readFileSync(LLM_CONFIG, "utf8")) as FileConfig;
}

/** 当前生效的那条线路；配置不对就抛错（比悄悄走错线路好） */
export function activeProfile(): LlmProfile & { id: string } {
  const c = readConfig();
  if (!isMulti(c)) return { id: "default", ...c };
  const ids = Object.keys(c.profiles);
  if (!ids.length) throw new Error("config/llm.json 里 profiles 是空的");
  const id = c.active && c.profiles[c.active] ? c.active : ids[0];
  return { id, ...c.profiles[id] };
}

/** 给页面看的清单：不带 key */
export function listProfiles(): { active: string; profiles: { id: string; label: string; model: string }[] } {
  if (!hasLlmConfig()) return { active: "", profiles: [] };
  const c = readConfig();
  if (!isMulti(c)) return { active: "default", profiles: [{ id: "default", label: "默认", model: c.model }] };
  const active = activeProfile().id;
  return {
    active,
    profiles: Object.entries(c.profiles).map(([id, p]) => ({ id, label: p.label || id, model: p.model })),
  };
}

export function setActiveProfile(id: string) {
  const c = readConfig();
  if (!isMulti(c) || !c.profiles[id]) throw new Error(`没有这条线路：${id}`);
  c.active = id;
  // 先写临时文件再改名，写到一半断电也不会留下半个 JSON
  const tmp = `${LLM_CONFIG}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, LLM_CONFIG);
}

/** 自我修复用的 pi 模型参数：当前线路配了 piModel 就跟着它，否则交给 pi 的默认 */
export function piModelArgs(): string[] {
  try {
    if (!hasLlmConfig()) return [];
    const m = activeProfile().piModel;
    return m ? ["--model", m] : [];
  } catch {
    return [];
  }
}
