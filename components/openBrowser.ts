"use client";

/**
 * 「在浏览器打开」：交给后台用系统默认浏览器开一个新标签页。
 * 只发一个路径给 /api/file（action=open）；网页正文里的 html 代码块先让后台落成临时文件（save-html）再打开同一套。
 * 返回空字符串表示开好了，否则是一句能直接给用户看的短提示。
 */
export async function openInBrowser(target: { path: string } | { html: string }): Promise<string> {
  try {
    let file = "path" in target ? target.path : "";
    if (!file) {
      const saved = await fetch("/api/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save-html", html: (target as { html: string }).html }),
      });
      const d = (await saved.json().catch(() => null)) as { ok?: boolean; path?: string; msg?: string } | null;
      if (!d?.ok || !d.path) return d?.msg || "没存下来，打不开";
      file = d.path;
    }
    const r = await fetch("/api/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: file, action: "open" }),
    });
    const d = (await r.json().catch(() => null)) as { ok?: boolean; msg?: string } | null;
    return d?.ok ? "" : d?.msg || "没打开，再点一次试试";
  } catch {
    return "没打开，连不上后台";
  }
}