import "server-only";
import { execFile } from "node:child_process";
import { activeMemories } from "./memory";

/**
 * 通知走哪条路：聊天页开着、且浏览器通知已授权时，由页面弹 Chrome 通知（点一下能跳回对话）；
 * 否则退回 macOS 系统通知。两条只走一条，不会重复打扰。
 */
const PRESENCE_TTL = 150_000;
const state = ((globalThis as unknown as { __dongniPresence?: { at: number; granted: boolean } }).__dongniPresence ??= {
  at: 0,
  granted: false,
});

export function touchPresence(granted: boolean) {
  state.at = Date.now();
  state.granted = granted;
}

export const browserWillNotify = () => state.granted && Date.now() - state.at < PRESENCE_TTL;

/** 对方给它起的名字（从记忆里找），没有就叫「懂你」 */
export function myName() {
  for (const m of activeMemories()) {
    const hit = m.content.match(/(?:起名|名字|叫)[^「」]*「([^」]{1,8})」/);
    if (hit) return hit[1];
  }
  return "懂你";
}

export function notify(text: string) {
  if (browserWillNotify()) return;
  const clean = (x: string) => x.replace(/\s+/g, " ").replace(/[\\"]/g, "");
  execFile(
    "/usr/bin/osascript",
    ["-e", `display notification "${clean(text).slice(0, 120)}" with title "${clean(myName())}" sound name "Glass"`],
    { timeout: 10_000 },
    () => {},
  );
}
