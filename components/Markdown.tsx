"use client";

import { ExternalLink } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import CardBlock from "./Cards";
import Chart from "./Chart";
import ImageFigure from "./ImageFigure";
import { openInBrowser } from "./openBrowser";
import { VoiceClip } from "./Voice";

/** 语音消息用图片语法存在正文里，但画的不是一个图片，是播放条 */
const isVoice = (src: string) => src.startsWith("/api/voice/clip/");

/**
 * 极简 Markdown：自己切块、自己拼 React 节点，全程不碰 innerHTML，所以不存在 XSS。
 * 认：代码块、标题、列表、引用、分割线、行内代码、加粗、斜体、删除线、链接。
 * 代码块用等宽字体 + 深色背景 + 横向滚动，长行不会把气泡撑破。
 */

/* ---------------- 块级 ---------------- */

type Block =
  | { type: "code"; lang: string; code: string }
  | { type: "heading"; level: number; text: string }
  | { type: "p"; text: string }
  | { type: "list"; ordered: boolean; start: number; items: { text: string; depth: number }[] }
  | { type: "quote"; text: string }
  | { type: "table"; head: string[]; align: ("left" | "right" | "center")[]; rows: string[][] }
  | { type: "images"; items: { alt: string; src: string }[] }
  | { type: "html"; items: { alt: string; html: string }[] }
  | { type: "hr" };

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const UL = /^(\s*)[-*+]\s+(.*)$/;
const OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const IMAGE_LINE = /^\s*(!\[[^\]]*\]\([^)\s]+\)\s*)+$/;
const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
/** 正文里直接以预览形式渲染出来的网页（<iframe srcDoc>）：html 原样放在 srcDoc="…" 里，老写法 src="data:text/html,…" 也认 */
const IFRAME_SRCDOC = /<iframe\b[^>]*\bsrcDoc="([^"]*)"/gi;
const IFRAME_DATA = /<iframe\b[^>]*\bsrc="data:text\/html(?:;charset=[\w-]+)?;base64,([^"]+)"/gi;

const cells = (l: string) =>
  l
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

const isTableStart = (lines: string[], i: number) => lines[i]?.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "") && lines[i + 1].includes("-");

const isImageLine = (l: string) => IMAGE_LINE.test(l) || /^\s*<iframe\b/i.test(l);

const isBlockStart = (l: string) =>
  FENCE.test(l) || HEADING.test(l) || HR.test(l) || UL.test(l) || OL.test(l) || QUOTE.test(l) || isImageLine(l);

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1];
      const lang = (fence[2] || "").toLowerCase();
      const body: string[] = [];
      const close = new RegExp(`^\\s*${marker}\\s*$`);
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++; // 跳过结束围栏（边生成边渲染时可能还没出现）
      out.push({ type: "code", lang, code: body.join("\n") });
      continue;
    }

    if (isTableStart(lines, i)) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left")) as (
        | "left"
        | "right"
        | "center"
      )[];
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push({ type: "table", head, align, rows });
      continue;
    }

    if (isImageLine(line)) {
      const items: { alt: string; src: string }[] = [];
      const htmls: { alt: string; html: string }[] = [];
      while (i < lines.length && isImageLine(lines[i])) {
        const cur = lines[i++];
        for (const m of cur.matchAll(IMAGE)) items.push({ alt: m[1], src: m[2] });
        // 预览的网页要给一个「在浏览器打开」：srcDoc 是写在此处的 html；data: 那种是 base64 的
        for (const m of cur.matchAll(IFRAME_SRCDOC)) htmls.push({ alt: "", html: decodeAttr(m[1]) });
        for (const m of cur.matchAll(IFRAME_DATA)) {
          const html = fromB64(m[1]);
          if (html !== null) htmls.push({ alt: "", html });
        }
      }
      if (items.length) out.push({ type: "images", items });
      if (htmls.length) out.push({ type: "html", items: htmls });
      continue;
    }

    const h = line.match(HEADING);
    if (h) {
      out.push({ type: "heading", level: h[1].length, text: h[2] });
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push({ type: "hr" });
      i++;
      continue;
    }

    const ul = line.match(UL);
    const ol = line.match(OL);
    if (ul || ol) {
      const ordered = !!ol;
      const items: { text: string; depth: number }[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        const m = ordered ? cur.match(OL) : cur.match(UL);
        if (m) {
          const indent = m[1].length;
          items.push({ text: ordered ? m[3] : m[2], depth: Math.min(3, Math.floor(indent / 2)) });
          i++;
          continue;
        }
        // 另外换了一种列表符号、或者碰到新块，就结束这个列表
        if ((ordered ? UL : OL).test(cur) || !cur.trim() || isBlockStart(cur)) break;
        // 缩进的续行算上一条的
        if (!/^\s+/.test(cur)) break;
        items[items.length - 1].text += `\n${cur.trim()}`;
        i++;
      }
      out.push({ type: "list", ordered, start: ordered ? Number(ol![2]) : 1, items });
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(QUOTE);
        if (!m) break;
        body.push(m[1]);
        i++;
      }
      out.push({ type: "quote", text: body.join("\n") });
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) && !isTableStart(lines, i)) buf.push(lines[i++]);
    if (buf.length) out.push({ type: "p", text: buf.join("\n") });
    else {
      out.push({ type: "p", text: line });
      i++;
    }
  }
  return out;
}

/** 属性里的 &quot; 之类还原回来；解出来不对就原样 */
function decodeAttr(s: string): string {
  const named: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", "#34": '"', "#39": "'", "#38": "&", "#60": "<", "#62": ">" };
  return s.replace(/&(quot|amp|lt|gt|apos|#\d+);/g, (all, k: string) => named[k] ?? all);
}

function fromB64(b64: string): string | null {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/* ---------------- 行内 ---------------- */

// 顺序很重要：代码、加粗、删除线在前，斜体、链接在后
const INLINE_SRC = /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|~~([\s\S]+?)~~|\*([^*\n]+?)\*|\[([^\]\n]*)\]\(([^)\s]+)\)/.source;

/** 只放行 http(s)/mailto 和自己写的相对路径，挡掉 javascript: 之类 */
function safeHref(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  if (/^(https?:\/\/|mailto:)/i.test(u)) return u;
  if (/^[\w./#?=&%+~-]+$/.test(u)) return u;
  return null;
}

function inline(text: string, prefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const key = () => `${prefix}-${n++}`;
  // 每次用新的正则：递归解析里面也会用，共用一个会把 lastIndex 弄乱
  const re = new RegExp(INLINE_SRC, "g");
  const pushText = (t: string) => {
    if (!t) return;
    t.split("\n").forEach((part, idx) => {
      if (idx) nodes.push(<br key={key()} />);
      if (part) nodes.push(part); // 普通字符串，React 自己转义
    });
  };

  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    pushText(text.slice(last, m.index));
    if (m[2] !== undefined) nodes.push(<code key={key()} className="md-code">{m[2]}</code>);
    else if (m[3] !== undefined) nodes.push(<strong key={key()}>{inline(m[3], key())}</strong>);
    else if (m[4] !== undefined) nodes.push(<del key={key()}>{inline(m[4], key())}</del>);
    else if (m[5] !== undefined) nodes.push(<em key={key()}>{inline(m[5], key())}</em>);
    else if (m[6] !== undefined) {
      const href = safeHref(m[7]);
      nodes.push(
        href ? (
          <a key={key()} href={href} target="_blank" rel="noreferrer noopener">
            {inline(m[6], key())}
          </a>
        ) : (
          <span key={key()}>{m[6]}</span>
        ),
      );
    }
    last = m.index + m[0].length;
  }
  pushText(text.slice(last));
  return nodes;
}

/* ---------------- 代码高亮（认几类 token，够看清结构就行） ---------------- */

const KEYWORDS = new Set(
  `const let var function return if else for while do switch case break continue class extends new this super import from export default async await try catch finally throw typeof instanceof void delete yield interface type enum implements public private protected readonly static abstract as satisfies keyof infer namespace declare get set of in is not and or None True False def elif lambda pass with print self except raise global nonlocal assert del echo fi then done esac local unset cd exit sudo fn func impl struct trait mut pub use crate mod match loop where select insert update delete join group order limit create table alter drop index values into null true false int float string bool boolean nil package range defer go chan map foreach elseif end begin rescue ensure puts require module do`.split(
    /\s+/,
  ),
);

const HASH_COMMENT = new Set([
  "py",
  "python",
  "sh",
  "bash",
  "zsh",
  "shell",
  "console",
  "yaml",
  "yml",
  "toml",
  "rb",
  "ruby",
  "r",
  "perl",
  "pl",
  "conf",
  "ini",
  "dockerfile",
  "docker",
  "makefile",
  "make",
  "gitignore",
  "env",
  "dotenv",
]);

function highlight(code: string, lang: string): ReactNode[] {
  const re = new RegExp(
    [
      HASH_COMMENT.has(lang) ? "#[^\\n]*" : null,
      "\\/\\/[^\\n]*",
      "\\/\\*[\\s\\S]*?\\*\\/",
      "<!--[\\s\\S]*?-->",
      "\"(?:\\\\.|[^\"\\\\\\n])*\"?|'(?:\\\\.|[^'\\\\\\n])*'?|`(?:\\\\.|[^`\\\\])*`?",
      "\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b",
      "[A-Za-z_$][\\w$]*",
    ]
      .filter((x): x is string => !!x)
      .join("|"),
    "g",
  );

  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const t = m[0];
    if (!t) {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out.push(code.slice(last, m.index));
    const cls = /^(\/\/|#|\/\*|<!--)/.test(t)
      ? "tk-com"
      : /^["'`]/.test(t)
        ? "tk-str"
        : /^\d/.test(t)
          ? "tk-num"
          : KEYWORDS.has(t)
            ? "tk-kw"
            : "";
    out.push(cls ? <span key={`t${n++}`} className={cls}>{t}</span> : t);
    last = m.index + t.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

/* ---------------- 网页 ---------------- */

/** 「在浏览器打开」入口的两种样子，动作是同一个：落成临时文件 → 系统默认浏览器新开一个标签页 */
function useBrowserOpen(html: string) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(""), 4000);
    return () => window.clearTimeout(t);
  }, [note]);
  const open = async () => {
    if (busy) return;
    setBusy(true);
    const msg = await openInBrowser({ html });
    setBusy(false);
    setNote(msg);
  };
  return { busy, note, open };
}

/** 正文里的 ```html 代码块：代码照旧显示，右上角一个「在浏览器打开」 */
function HtmlCode({ code }: { code: string }) {
  const { busy, note, open } = useBrowserOpen(code);
  return (
    <div className="md-html">
      <button type="button" className="md-html-btn" disabled={busy} onClick={open} title="在浏览器里开一个新标签页">
        <ExternalLink size={12} strokeWidth={1.9} />
        在浏览器打开
      </button>
      <pre className="md-pre scroll-thin">
        <code>{highlight(code, "html")}</code>
      </pre>
      {!!note && <span className="md-html-note">{note}</span>}
    </div>
  );
}

/** 已经以预览形式渲染在消息里的网页：下面给一行「在浏览器打开」 */
function HtmlLink({ html }: { html: string }) {
  const { busy, note, open } = useBrowserOpen(html);
  return (
    <span className="md-html-row">
      <button type="button" className="md-html-link" disabled={busy} onClick={open}>
        <ExternalLink size={12} strokeWidth={1.9} />
        在浏览器打开
      </button>
      {!!note && <span className="md-html-note">{note}</span>}
    </span>
  );
}

/* ---------------- 组装 ---------------- */

export default function Markdown({ text, animate = false, voiceAuto = false }: { text: string; animate?: boolean; voiceAuto?: boolean }) {
  const blocks = parse(text);
  return (
    <div className={animate ? "md md-anim" : "md"}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case "code": {
            // 图表、卡片：代码块里是 JSON；边生成边渲染时 JSON 还不完整，就先不显示
            if (b.lang === "chart" || b.lang === "card") {
              let spec: unknown;
              try {
                spec = JSON.parse(b.code);
              } catch {
                return null;
              }
              if (b.lang === "chart") return <Chart key={i} spec={spec} />;
              return <CardBlock key={i} items={(Array.isArray(spec) ? spec : [spec]) as Record<string, unknown>[]} />;
            }
            // 网页代码块：正文里直接看照样是代码，旁边给一个「在浏览器打开」，点了先把这段落成临时文件再去浏览器里开
            if (b.lang === "html") return <HtmlCode key={i} code={b.code} />;
            return (
              <pre key={i} className="md-pre scroll-thin">
                <code>{highlight(b.code, b.lang)}</code>
              </pre>
            );
          }
          case "table":
            return (
              <div key={i} className="md-table-wrap scroll-thin">
                <table className="md-table">
                  <thead>
                    <tr>
                      {b.head.map((c, k) => (
                        <th key={k} style={{ textAlign: b.align[k] ?? "left" }}>
                          {inline(c, `th${i}-${k}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri}>
                        {b.head.map((_, k) => (
                          <td key={k} style={{ textAlign: b.align[k] ?? "left" }}>
                            {inline(r[k] ?? "", `td${i}-${ri}-${k}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "images":
            return (
              <div key={i} className={b.items.length > 1 ? "md-imgs md-imgs-multi" : "md-imgs"}>
                {b.items.map((im, k) =>
                  safeHref(im.src) ? (
                    isVoice(im.src) ? <VoiceClip key={k} src={im.src} auto={voiceAuto} /> : /^(\/api\/|\/mood\/|https?:\/\/)/.test(im.src) ? <ImageFigure key={k} src={im.src} alt={im.alt} /> : null
                  ) : null,
                )}
              </div>
            );
          case "html":
            return (
              <div key={i} className="md-html-links">
                {b.items.map((h, k) => (
                  <HtmlLink key={k} html={h.html} />
                ))}
              </div>
            );
          case "heading":
            return (
              <p key={i} className={`md-head md-head-${Math.min(6, b.level)}`}>
                {inline(b.text, `h${i}`)}
              </p>
            );
          case "list": {
            const items = b.items.map((it, k) => (
              <li key={k} style={it.depth ? { marginLeft: it.depth * 16 } : undefined}>
                {inline(it.text, `l${i}-${k}`)}
              </li>
            ));
            return b.ordered ? (
              <ol key={i} className="md-list" start={b.start}>
                {items}
              </ol>
            ) : (
              <ul key={i} className="md-list">
                {items}
              </ul>
            );
          }
          case "quote":
            return (
              <blockquote key={i} className="md-quote">
                {inline(b.text, `q${i}`)}
              </blockquote>
            );
          case "hr":
            return <hr key={i} className="md-hr" />;
          default:
            return (
              <p key={i} className="md-p">
                {inline(b.text, `p${i}`)}
              </p>
            );
        }
      })}
    </div>
  );
}