"use client";

import { useEffect } from "react";

const KEY = "dongni:version";
const INTERVAL = 4000;

/** 读页面来时记下的版本；第一次打开没记过，就认现在这个，不白刷一次 */
function readSeen(now: number): number {
  try {
    const v = Number(sessionStorage.getItem(KEY));
    if (v > 0) return v;
    sessionStorage.setItem(KEY, String(now));
  } catch {}
  return now;
}

/**
 * 后台重启后自己刷新一次：选好要刷的版本、记下来，再刷新。
 * 先写版本再刷：哪怕刷新前请求还在路上，刷新后页面也只会认新版本，不会再连着刷。
 */
function reloadWith(version: number, keep: () => void) {
  try {
    keep();
  } catch {}
  try {
    sessionStorage.setItem(KEY, String(version));
  } catch {}
  location.reload();
}

/**
 * 后台换代码重启了，页面自己刷新，不用手动按 cmd+R。
 * 每 4 秒问一下 /api/version：连不上（说明服务在重启）就算断开，等它回来；
 * 回来的版本号和打开页面时记的不一样，才刷新一次——刷完记的是新版本，不会再循环。
 * 刷新前调一下 keep()：他的草稿和图原样回来。
 */
export default function useAutoReload(keep: () => void) {
  useEffect(() => {
    let seen = 0;
    let seenKnown = false;
    let reloading = false;
    let running = false;
    let stopped = false;
    let timer = 0;

    const check = async () => {
      if (running || stopped) return; // 上一轮还没回来（比如服务卡住）就别叠着问
      running = true;
      const ctrl = new AbortController();
      const abort = window.setTimeout(() => ctrl.abort(), INTERVAL);
      let now: number | null = null;
      try {
        const res = await fetch("/api/version", { cache: "no-store", signal: ctrl.signal });
        if (res.ok) {
          const v = Number(((await res.json()) as { startedAt?: number }).startedAt);
          if (v > 0) now = v;
        }
      } catch {}
      window.clearTimeout(abort);
      running = false;
      if (stopped) return;

      if (now === null) {
        // 连不上：服务在重启，接着等下一轮；别在这时候刷新，刷出来也是打不开的
        return;
      }
      if (reloading) {
        // 就是这次刷新之前要认的版本；刷新真发生了页面早走了，走到这说明没刷动，下一轮接着刷
        return;
      }
      if (!seenKnown) {
        seen = readSeen(now);
        seenKnown = true;
      }
      if (now !== seen) {
        reloading = true; // 同一版本只刷一次，请求还在路上也不会刷两遍
        reloadWith(now, keep);
      }
    };

    void check();
    timer = window.setInterval(() => void check(), INTERVAL);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
    // keep 只是刷新前顺手存一下草稿，换了也不要重开轮询
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}