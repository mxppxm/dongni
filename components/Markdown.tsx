"use client";

import type { ReactNode } from "react";
import CardBlock from "./Cards";
import Chart from "./Chart";
import ImageFigure from "./ImageFigure";
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

const cells = (l: string) =>
  l
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

const isTableStart = (lines: string[], i: number) => lines[i]?.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "") && lines[i + 1].includes("-");

const isBlockStart = (l: string) =>
  FENCE.test(l) || HEADING.test(l) || HR.test(l) || UL.test(l) || OL.test(l) || QUOTE.test(l) || IMAGE_LINE.test(l);

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

    if (IMAGE_LINE.test(line)) {
      const items: { alt: string; src: string }[] = [];
      while (i < lines.length && IMAGE_LINE.test(lines[i])) {
        for (const m of lines[i].matchAll(IMAGE)) items.push({ alt: m[1], src: m[2] });
        i++;
      }
      out.push({ type: "images", items });
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
                    isVoice(im.src) ? <VoiceClip key={k} src={im.src} auto={voiceAuto} /> : <ImageFigure key={k} src={im.src} alt={im.alt} />
                  ) : null,
                )}
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