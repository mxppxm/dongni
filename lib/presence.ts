import "server-only";
import { EventEmitter } from "node:events";

/**
 * 一条路：她只有一场对话。打字、语音消息、电话里说的话都是「进来的口子」，
 * 对话框和电话都是「出去的口子」——中间只有一颗脑子、一条排队的回复流。
 *
 * 这里放两样所有口子共用的东西：
 * - 在场：现在是不是在打电话（主动消息、提醒、重启、说话风格都要先看一眼）
 * - 回复广播：每条回复生成时的每个字都从这里发出去，电话那头订阅着就念出来，不管这句话是从哪个口子进来的
 */
export type ReplyEvent =
  | { assistantId: number; type: "start" }
  | { assistantId: number; type: "delta"; text: string }
  | { assistantId: number; type: "reset" }
  | { assistantId: number; type: "mood"; mood: string }
  | { assistantId: number; type: "done" };

type State = { calls: number; hub: EventEmitter };
const state = ((globalThis as unknown as { __dongniPresence?: State }).__dongniPresence ??= {
  calls: 0,
  hub: new EventEmitter().setMaxListeners(50),
});

export const onCall = () => state.calls > 0;

/** 电话接通 / 挂断各调一次 */
export function callStarted() {
  state.calls++;
  state.hub.emit("presence");
}
export function callEnded() {
  state.calls = Math.max(0, state.calls - 1);
  state.hub.emit("presence");
}

/** 等到不在通话（改完自己要重启时用：别把电话挂了） */
export function whenOffCall(): Promise<void> {
  if (!onCall()) return Promise.resolve();
  return new Promise((ok) => {
    const check = () => {
      if (onCall()) return;
      state.hub.off("presence", check);
      ok();
    };
    state.hub.on("presence", check);
  });
}

export function publishReply(e: ReplyEvent) {
  state.hub.emit("reply", e);
}

export function subscribeReplies(fn: (e: ReplyEvent) => void) {
  state.hub.on("reply", fn);
  return () => void state.hub.off("reply", fn);
}

/* ---------- 打断：电话里他插话，正在想的那句停下，只留已经说出口的 ---------- */
const stops = ((globalThis as unknown as { __dongniStops?: Map<number, string> }).__dongniStops ??= new Map());

/** spoken：已经念出去的部分；生成那边会把回复改成这句 + 「……」 */
export function stopReply(assistantId: number, spoken: string) {
  stops.set(assistantId, spoken);
}
export function stoppedReply(assistantId: number): string | undefined {
  return stops.get(assistantId);
}
export function clearStop(assistantId: number) {
  stops.delete(assistantId);
}
