"use client";

import { Bell, BellOff, ExternalLink, File, FileArchive, FileImage, FileText, Globe } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * 卡片：链接、文件、提醒。链接和提醒用同一套壳（浅底、细边框、圆角、hover 微微上浮）；
 * 文件卡片单独做成一张纸的样子：左边类型图标，右边文件名 + 类型/大小/时间，
 * 「在 Finder 中显示」只是右下角一行小字，不做成按钮。
 * 内容全部来自消息里的 JSON，不认 HTML。
 */

type Spec = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function fmtSize(n: number) {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function stampText(ms: number) {
  const d = new Date(ms);
  const now = new Date();
  return d.toLocaleString("zh-CN", {
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function whenText(ms: number) {
  return new Date(ms).toLocaleString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function LinkCard({ spec }: { spec: Spec }) {
  const url = str(spec.url);
  const host = hostOf(url);
  const [badIcon, setBadIcon] = useState(false);
  if (!/^https?:\/\//i.test(url)) return null;
  return (
    <a className="card card-link" href={url} target="_blank" rel="noreferrer noopener">
      <span className="card-icon">
        {badIcon || !host ? (
          <Globe size={16} strokeWidth={1.7} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(host)}`} alt="" onError={() => setBadIcon(true)} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="card-title">{str(spec.title) || host || url}</span>
        <span className="card-sub">{str(spec.desc) || host}</span>
      </span>
      <ExternalLink size={14} strokeWidth={1.7} className="card-tail" />
    </a>
  );
}

const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff", "svg"];
const ARCHIVE_EXT = ["zip", "rar", "7z", "tar", "gz", "dmg", "pkg"];

function iconFor(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXT.includes(ext)) return <FileImage size={18} strokeWidth={1.7} />;
  if (ARCHIVE_EXT.includes(ext)) return <FileArchive size={18} strokeWidth={1.7} />;
  if (["pdf", "doc", "docx", "txt", "md", "rtf", "pages", "key", "ppt", "pptx", "xls", "xlsx", "csv"].includes(ext))
    return <FileText size={18} strokeWidth={1.7} />;
  return <File size={18} strokeWidth={1.7} />;
}

/** 文件类型的小字：说人话，认得多少说多少 */
const KIND: Record<string, string> = {
  pdf: "PDF",
  doc: "Word 文档",
  docx: "Word 文档",
  pages: "Pages 文档",
  rtf: "RTF 文档",
  txt: "纯文本",
  md: "Markdown",
  markdown: "Markdown",
  csv: "CSV 表格",
  xls: "表格",
  xlsx: "表格",
  numbers: "Numbers 表格",
  ppt: "演示文稿",
  pptx: "演示文稿",
  key: "Keynote",
  json: "JSON",
  yml: "YAML",
  yaml: "YAML",
  html: "网页",
  htm: "网页",
  css: "样式表",
  js: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  py: "Python",
  sh: "脚本",
  png: "图片",
  jpg: "图片",
  jpeg: "图片",
  gif: "图片",
  webp: "图片",
  heic: "图片",
  svg: "图片",
  mp3: "音频",
  m4a: "音频",
  wav: "音频",
  mp4: "视频",
  mov: "视频",
  zip: "压缩包",
  rar: "压缩包",
  "7z": "压缩包",
  tar: "压缩包",
  gz: "压缩包",
  dmg: "安装包",
  pkg: "安装包",
};

const kindOf = (name: string, ext: string) => (ext ? KIND[ext] || `${ext.toUpperCase()} 文件` : "文件");

type FileInfo = { ok: boolean; name?: string; size?: number; mtime?: number; dir?: boolean };

function FileCard({ spec }: { spec: Spec }) {
  const target = str(spec.path);
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!target) return;
    let alive = true;
    fetch(`/api/file?path=${encodeURIComponent(target)}`)
      .then((r) => r.json())
      .then((d: FileInfo) => alive && setInfo(d))
      .catch(() => alive && setInfo({ ok: false }));
    return () => {
      alive = false;
    };
  }, [target]);

  if (!target) return null;
  const name = info?.name || str(spec.name) || target.split("/").pop() || "";
  const size = info?.size ?? (typeof spec.size === "number" ? spec.size : undefined);
  const mtime = typeof info?.mtime === "number" ? info.mtime : undefined;
  const gone = !!info && !info.ok;
  const rawExt = (name.match(/\.([^.\\/]+)$/)?.[1] ?? "").toLowerCase();
  const ext = rawExt && name.length > rawExt.length + 1 ? rawExt : "";
  const base = ext ? name.slice(0, -(ext.length + 1)) : name;
  const meta = gone
    ? "这个文件不在了"
    : [info?.dir ? "文件夹" : kindOf(name, ext), size !== undefined ? fmtSize(size) : "", mtime ? stampText(mtime) : ""]
        .filter(Boolean)
        .join(" · ");

  return (
    <div className="filecard">
      <span className="filecard-icon" aria-hidden>
        {iconFor(name)}
      </span>
      <div className="filecard-main">
        <div className="filecard-name">
          <span className="filecard-name-main">{base}</span>
          {!!ext && !gone && <span className="filecard-ext">.{ext}</span>}
        </div>
        <div className="filecard-sub">
          <span className="filecard-meta">{meta}</span>
          {!gone && (
            <button
              type="button"
              className="filecard-act"
              onClick={async () => {
                setShown(true);
                await fetch("/api/file", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ path: target }),
                }).catch(() => {});
                window.setTimeout(() => setShown(false), 1500);
              }}
            >
              {shown ? "打开了" : "在 Finder 中显示"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ReminderCard({ spec }: { spec: Spec }) {
  const id = Number(spec.id);
  const raw = spec.at;
  const at = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
  const [cancelled, setCancelled] = useState(false);
  const text = str(spec.text);
  if (!text) return null;
  return (
    <div className="card card-reminder">
      <span className="card-icon">{cancelled ? <BellOff size={16} strokeWidth={1.7} /> : <Bell size={16} strokeWidth={1.7} />}</span>
      <span className="min-w-0 flex-1">
        <span className="card-title">{text}</span>
        <span className="card-sub">{Number.isFinite(at) ? whenText(at) : ""}</span>
      </span>
      {Number.isFinite(id) &&
        (cancelled ? (
          <span className="card-tail">已取消</span>
        ) : (
          <button
            type="button"
            className="card-btn"
            onClick={async () => {
              const r = await fetch("/api/reminders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id }),
              }).catch(() => null);
              if (r?.ok) setCancelled(true);
            }}
          >
            取消
          </button>
        ))}
    </div>
  );
}

export default function CardBlock({ items }: { items: Spec[] }) {
  if (!items.length) return null;
  return (
    <div className="cards">
      {items.map((spec, i) => {
        const type = str(spec.type);
        if (type === "link") return <LinkCard key={i} spec={spec} />;
        if (type === "file") return <FileCard key={i} spec={spec} />;
        if (type === "reminder") return <ReminderCard key={i} spec={spec} />;
        return null;
      })}
    </div>
  );
}