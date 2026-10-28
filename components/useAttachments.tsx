"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/** 拖进输入框的图片：只放缩略图，发送时随消息一起给模型 */
export type Attachment = { key: string; dataUrl: string; mime: string };

const MAX_COUNT = 3;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL = 10 * 1024 * 1024;

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const bytesOf = (dataUrl: string) => Math.round((dataUrl.length * 3) / 4);

export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const listRef = useRef<Attachment[]>([]);
  const timer = useRef<number | null>(null);
  const depth = useRef(0);

  useEffect(() => {
    listRef.current = items;
  }, [items]);

  const say = useCallback((text: string) => {
    setHint(text);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHint(null), 3200);
  }, []);

  const add = useCallback(
    async (files: File[]) => {
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (!images.length) {
        say("只能放图片进来");
        return;
      }
      const next: Attachment[] = [];
      let count = listRef.current.length;
      let total = listRef.current.reduce((s, a) => s + bytesOf(a.dataUrl), 0);
      let tooBig = false;
      let tooMany = false;
      for (const file of images) {
        if (count >= MAX_COUNT || total + file.size > MAX_TOTAL) {
          tooMany = true;
          continue;
        }
        if (file.size > MAX_BYTES) {
          tooBig = true;
          continue;
        }
        try {
          const dataUrl = await readAsDataUrl(file);
          next.push({ key: crypto.randomUUID(), dataUrl, mime: file.type });
          count += 1;
          total += file.size;
        } catch {
          say("这张读不出来，换一张试试");
        }
      }
      if (tooBig) say("这张太大啦（超过 4MB），换张小点的");
      else if (tooMany) say(`一次最多 ${MAX_COUNT} 张图`);
      if (next.length) setItems((list) => [...list, ...next]);
    },
    [say],
  );

  const remove = useCallback((key: string) => setItems((list) => list.filter((a) => a.key !== key)), []);
  const clear = useCallback(() => setItems([]), []);

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      // 只有图、没有文字时才拦下来，别把正常粘贴弄坏
      if (!e.clipboardData.getData("text/plain")) e.preventDefault();
      void add(files);
    },
    [add],
  );

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    depth.current += 1;
    setDragging(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      void add(Array.from(e.dataTransfer.files ?? []));
    },
    [add],
  );

  return { items, hint, dragging, add, remove, clear, onPaste, onDragEnter, onDragOver, onDragLeave, onDrop };
}

export function AttachmentStrip({ items, onRemove }: { items: Attachment[]; onRemove: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="mb-1.5 flex flex-wrap gap-2">
      {items.map((a) => (
        <div key={a.key} className="attach">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={a.dataUrl} alt="" />
          <button type="button" onClick={() => onRemove(a.key)} aria-label="去掉这张">
            <X size={10} strokeWidth={3} />
          </button>
        </div>
      ))}
    </div>
  );
}