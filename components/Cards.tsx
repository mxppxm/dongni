"use client";

import { Bell, BellOff, ExternalLink, File, FileArchive, FileImage, FileText, FolderOpen, Globe } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * 卡片：链接、文件、提醒。三种用同一套壳（浅底、细边框、圆角、hover 微微上浮），
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

function iconFor(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff"].includes(ext)) return <FileImage size={16} strokeWidth={1.7} />;
  if (["zip", "rar", "7z", "tar", "gz", "dmg", "pkg"].includes(ext)) return <FileArchive size={16} strokeWidth={1.7} />;
  if (["pdf", "doc", "docx", "txt", "md", "rtf", "pages", "key", "ppt", "pptx", "xls", "xlsx", "csv"].includes(ext))
    return <FileText size={16} strokeWidth={1.7} />;
  return <File size={16} strokeWidth={1.7} />;
}

function FileCard({ spec }: { spec: Spec }) {
  const target = str(spec.path);
  const [info, setInfo] = useState<{ ok: boolean; name?: string; size?: number } | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!target) return;
    let alive = true;
    fetch(`/api/file?path=${encodeURIComponent(target)}`)
      .then((r) => r.json())
      .then((d: { ok: boolean; name?: string; size?: number }) => alive && setInfo(d))
      .catch(() => alive && setInfo({ ok: false }));
    return () => {
      alive = false;
    };
  }, [target]);

  if (!target) return null;
  const name = info?.name || str(spec.name) || target.split("/").pop() || "";
  const size = info?.size ?? (typeof spec.size === "number" ? spec.size : undefined);
  const gone = info && !info.ok;

  return (
    <div className="card card-file">
      <span className="card-icon">{iconFor(name)}</span>
      <span className="min-w-0 flex-1">
        <span className="card-title">{name}</span>
        <span className="card-sub">{gone ? "这个文件不在了" : size !== undefined ? fmtSize(size) : ""}</span>
      </span>
      {!gone && (
        <button
          type="button"
          className="card-btn"
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
          <FolderOpen size={13} strokeWidth={1.8} />
          {shown ? "打开了" : "在 Finder 中显示"}
        </button>
      )}
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