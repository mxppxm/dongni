import "server-only";
import { execFile } from "node:child_process";
import { activeMemories } from "./memory";

/**
 * 通知走哪条路：聊天页开着、且浏览器通知已授权时，由页面弹 Chrome 通知（点一下能跳回对话）；
 * 否则退回 macOS 系统通知。两条只走一条，不会重复打扰。
 */
const PRESENCE_TTL = 150_000;
type Presence = { at: number; granted: boolean; visibleAt: number; back: Set<() => void> };
const state = ((globalThis as unknown as { __dongniNotifyPresence?: Presence }).__dongniNotifyPresence ??= {
  at: 0,
  granted: false,
  visibleAt: 0,
  back: new Set(),
});

/** 多久没看到页面在前台，算他不在跟前 */
const AWAY_MS = 100_000;

/** visible：页面这会儿是不是在他眼前（标签页在前台）。从不在跟前变成在跟前时，通知等着的人（攒着的话该说了） */
export function touchPresence(granted: boolean, visible = false) {
  const wasAway = !pageVisible();
  state.at = Date.now();
  state.granted = granted;
  if (!visible) return;
  state.visibleAt = Date.now();
  if (wasAway)
    for (const fn of state.back) {
      try {
        fn();
      } catch {}
    }
}

/** 聊天页现在在他眼前吗 */
export const pageVisible = () => Date.now() - state.visibleAt < AWAY_MS;

/** 他回到页面跟前时叫一声 */
export function onBack(fn: () => void) {
  state.back.add(fn);
  return () => void state.back.delete(fn);
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
