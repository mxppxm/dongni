import "server-only";
import { db, getKv, setKv, type LinkRow, type MemoryRow, type MessageRow } from "./db";
import { completeJson } from "./llm";
import { stripImageMarkdown } from "./images";

export const CATEGORIES = ["人", "偏好", "经历", "近况", "想法"] as const;

export function nowText(ts = Date.now()) {
  return new Date(ts).toLocaleString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/* ---------------- 查询 ---------------- */

export function activeMemories(): MemoryRow[] {
  return db().prepare("SELECT * FROM memories WHERE status = 'active' ORDER BY id").all() as MemoryRow[];
}

export function allLinks(): LinkRow[] {
  return db()
    .prepare(
      `SELECT l.a, l.b, l.reason FROM memory_links l
       JOIN memories ma ON ma.id = l.a AND ma.status = 'active'
       JOIN memories mb ON mb.id = l.b AND mb.status = 'active'`,
    )
    .all() as LinkRow[];
}

/** 中文按两字切、英文按词切，用来算文本相关度（接口没有向量化，用这个顶上，几千条以内足够快） */
function grams(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z0-9]{2,}/g) ?? []) out.add(w);
  for (const run of lower.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** 选出和当前话题相关的记忆：记忆不多时全给；多了按相关度 + 关联扩展 + 最近的挑 */
export function relevantMemories(query: string, limit = 60): MemoryRow[] {
  const mems = activeMemories();
  if (mems.length <= 200) return mems;

  const q = grams(query);
  const scored = mems
    .map((m) => {
      const g = grams(m.content);
      let hit = 0;
      for (const t of g) if (q.has(t)) hit++;
      return { m, s: hit / Math.sqrt(g.size + 1) };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.floor(limit * 0.5));

  const picked = new Map<number, MemoryRow>(scored.map((x) => [x.m.id, x.m]));
  const byId = new Map(mems.map((m) => [m.id, m]));
  for (const l of allLinks()) {
    if (picked.size >= limit * 0.75) break;
    if (picked.has(l.a) && !picked.has(l.b) && byId.has(l.b)) picked.set(l.b, byId.get(l.b)!);
    else if (picked.has(l.b) && !picked.has(l.a) && byId.has(l.a)) picked.set(l.a, byId.get(l.a)!);
  }
  for (const m of [...mems].sort((a, b) => b.updated_at - a.updated_at)) {
    if (picked.size >= limit) break;
    picked.set(m.id, m);
  }
  return [...picked.values()].sort((a, b) => a.id - b.id);
}

export function formatMemories(mems: MemoryRow[]) {
  return mems.map((m) => `#${m.id} [${m.category}] ${m.content}`).join("\n");
}

/* ---------------- 记忆整理（后台） ---------------- */

type ExtractResult = {
  add?: { content: string; category: string; source?: number; links?: { to: string | number; reason?: string }[] }[];
  update?: { id: number; content?: string; category?: string }[];
  remove?: number[];
  links?: { a: number; b: number; reason?: string }[];
};

const EXTRACT_PROMPT = (today: string) => `你是一个记忆整理员。用户在和自己的私人 AI 伙伴聊天，你负责根据新的对话，维护「关于用户的长期记忆」。今天是 ${today}。

规则：
1. 只记关于用户本人、以后聊天用得上的信息：身边的人和关系、偏好习惯、经历、近况和计划、想法观点、持续性的情绪状态。
2. 一条记忆只写一件事，用简短陈述句，主语是用户时省略主语，不超过 40 字。涉及时间的写成具体日期（如「周五」写成「11月1日（周五）」）。
3. 不记：寒暄客套、AI 自己说的话、一次性的琐碎小事、已有记忆里已经有的内容。用户只是随口一提且没信息量的，不记。
4. 新信息改变了已有记忆（搬家、换工作、计划变了、关系变了），用 update 改那条旧记忆，不要新增一条。
5. 已有记忆失效、被用户否认，或用户要求忘掉/别记，用 remove 删掉对应的记忆。用户要求忘掉的内容也不要再 add。
6. 每条新记忆，从已有记忆里找真正相关的连上（同一个人、因果、同一件事的不同方面、相互矛盾），写进 links，reason 不超过 8 个字。不要为了连而连。新记忆之间互连用 "new:序号"（序号从 0 开始）。
7. 已有记忆之间如果因为这段对话发现了新的关联，写进顶层 links。
8. 每条新记忆的 source 填它出自哪条用户消息的编号（新对话里「用户[#编号]」的那个数字）。
9. 没有值得记的，就返回空数组。

只输出 JSON：
{"add":[{"content":"","category":"人|偏好|经历|近况|想法","source":34,"links":[{"to":12,"reason":""},{"to":"new:1","reason":""}]}],"update":[{"id":12,"content":"","category":""}],"remove":[12],"links":[{"a":3,"b":9,"reason":""}]}`;

// instrumentation 和路由在 Next 里是不同的模块实例，状态挂在 globalThis 上才能共用，避免同一批被整理两次
const state = ((globalThis as unknown as { __dongniWorker?: { running: boolean; failures: number; timer: NodeJS.Timeout | null } })
  .__dongniWorker ??= { running: false, failures: 0, timer: null });

export function scheduleExtraction(delayMs = 5000) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    void runExtraction();
  }, delayMs);
}

export async function runExtraction() {
  if (state.running) return;
  state.running = true;
  try {
    for (let round = 0; round < 20; round++) {
      const pending = db()
        .prepare("SELECT * FROM messages WHERE role = 'user' AND extracted = 0 ORDER BY id LIMIT 10")
        .all() as MessageRow[];
      if (!pending.length) break;
      // 等回复写完再整理，回复也是理解上下文的一部分
      const lastId = pending[pending.length - 1].id;
      const streaming = db().prepare("SELECT 1 FROM messages WHERE status = 'streaming' AND id > ? LIMIT 1").get(lastId);
      if (streaming) {
        scheduleExtraction(5000);
        break;
      }
      try {
        await extractBatch(pending);
        state.failures = 0;
      } catch (e) {
        // 超时、断网、接口 5xx/429 这类是模型那边的事，不算这一批的错：留着下轮再整理
        // 只有内容/解析失败连续 3 次才跳过这一批（原话仍完整保存在 messages 里，不丢），免得卡住后面的
        if (!isTransient(e) && ++state.failures >= 3) {
          const ids = pending.map((m) => m.id);
          db().prepare(`UPDATE messages SET extracted = 2 WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
          state.failures = 0;
        }
        throw e;
      }
    }
    await maybeRebuildProfile();
  } catch (e) {
    console.error("[dongni] 记忆整理失败，稍后重试：", e);
  } finally {
    state.running = false;
  }
}

/** 一时的失败：超时、中断、网络不通、接口 5xx/429、鉴权（配置问题，等修好就好） */
function isTransient(e: unknown) {
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return true;
  const msg = String(err?.message ?? "");
  if (/模型接口 (5\d\d|429|401|403)\b/.test(msg)) return true;
  return /fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket/i.test(msg + " " + String(err?.cause?.code ?? ""));
}

async function extractBatch(pending: MessageRow[]) {
  const firstId = pending[0].id;
  const lastId = pending[pending.length - 1].id;
  const before = (
    db().prepare("SELECT * FROM messages WHERE id < ? AND status = 'done' AND kind != 'system' ORDER BY id DESC LIMIT 6").all(firstId) as MessageRow[]
  ).reverse();
  const batch = db()
    .prepare("SELECT * FROM messages WHERE id >= ? AND id <= ? + 1 AND status != 'error' AND kind != 'system' ORDER BY id")
    .all(firstId, lastId) as MessageRow[];

  const fmt = (ms: MessageRow[]) =>
    ms.map((m) => `${m.role === "user" ? `用户[#${m.id}]` : "AI"}（${nowText(m.created_at)}）：${stripImageMarkdown(m.content) || "[图片]"}`).join("\n");
  const newText = batch.map((m) => m.content).join("\n");
  const existing = relevantMemories(newText, 150);

  const result = await completeJson<ExtractResult>([
    { role: "system", content: EXTRACT_PROMPT(nowText()) },
    {
      role: "user",
      content: `【已有记忆】\n${formatMemories(existing) || "（还没有）"}\n\n【前情（已经整理过，仅供理解）】\n${fmt(before) || "（无）"}\n\n【新对话（需要整理）】\n${fmt(batch)}`,
    },
  ]);

  applyResult(
    result,
    lastId,
    new Set(batch.filter((m) => m.role === "user").map((m) => m.id)),
    new Set(existing.map((m) => m.id)),
  );
  const ids = pending.map((m) => m.id);
  db().prepare(`UPDATE messages SET extracted = 1 WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
}

/** shown：这一批给模型看过的已有记忆，改/删只认这些 id（模型编出来的 id 会误删别的记忆） */
function applyResult(r: ExtractResult, sourceId: number, userIds: Set<number>, shown: Set<number>) {
  const d = db();
  // 模型偶尔不给数组（比如给个数字），直接迭代会整批报错
  const arr = <T,>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
  const adds = arr(r.add);
  const now = Date.now();
  const exists = (id: number) => !!d.prepare("SELECT 1 FROM memories WHERE id = ? AND status = 'active'").get(id);
  const cat = (c?: string) => (CATEGORIES as readonly string[]).includes(c ?? "") ? c! : "想法";
  const link = d.prepare(
    "INSERT INTO memory_links(a, b, reason) VALUES(?, ?, ?) ON CONFLICT(a, b) DO UPDATE SET reason = excluded.reason",
  );
  const addLink = (x: number, y: number, reason = "") => {
    if (x === y || !exists(x) || !exists(y)) return;
    link.run(Math.min(x, y), Math.max(x, y), reason.slice(0, 16));
  };

  d.transaction(() => {
    for (const raw of arr(r.remove)) {
      const id = Number(raw);
      if (!shown.has(id)) continue;
      d.prepare("UPDATE memories SET status = 'deleted', updated_at = ? WHERE id = ?").run(now, id);
    }
    for (const u of arr(r.update)) {
      if (!u || !shown.has(Number(u.id)) || !exists(u.id) || typeof u.content !== "string" || !u.content.trim()) continue;
      d.prepare("UPDATE memories SET content = ?, category = COALESCE(?, category), updated_at = ? WHERE id = ?").run(
        u.content.trim(),
        u.category ? cat(u.category) : null,
        now,
        u.id,
      );
    }
    const newIds: number[] = [];
    const ins = d.prepare(
      "INSERT INTO memories(content, category, source_message_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?)",
    );
    for (const a of adds) {
      if (!a || typeof a.content !== "string" || !a.content.trim()) {
        newIds.push(-1);
        continue;
      }
      const src = userIds.has(Number(a.source)) ? Number(a.source) : sourceId;
      newIds.push(Number(ins.run(a.content.trim(), cat(a.category), src, now, now).lastInsertRowid));
    }
    const resolve = (to: string | number) => {
      if (typeof to === "string" && to.startsWith("new:")) return newIds[Number(to.slice(4))] ?? -1;
      return Number(to);
    };
    adds.forEach((a, i) => {
      for (const l of arr(a?.links)) addLink(newIds[i], resolve(l.to), l.reason);
    });
    for (const l of arr(r.links)) addLink(Number(l.a), Number(l.b), l.reason);
  })();
}

/* ---------------- 画像 ---------------- */

export function getProfile() {
  return getKv("profile") ?? "";
}

export function setProfile(text: string) {
  setKv("profile", text);
}

async function maybeRebuildProfile() {
  const lastAt = Number(getKv("profile_msg_id") ?? 0);
  const newUserMsgs = (
    db().prepare("SELECT COUNT(*) n FROM messages WHERE role = 'user' AND extracted = 1 AND id > ?").get(lastAt) as { n: number }
  ).n;
  const mems = activeMemories();
  const profile = getProfile();
  const due = profile ? newUserMsgs >= 12 : mems.length >= 3;
  if (!due) return;

  const maxId = (db().prepare("SELECT MAX(id) m FROM messages").get() as { m: number }).m;
  const r = await completeJson<{ profile: string }>([
    {
      role: "system",
      content: `你在为一个私人 AI 伙伴写「我眼中的你」：一份关于用户的画像，它每次聊天都会先读这份画像。今天是 ${nowText()}。
要求：
- 用第二人称「你」来写，像一个很熟的朋友写给对方的观察，自然、具体，不空泛，不吹捧。
- 覆盖：你是什么样的人（性格、说话方式）、生活里重要的人、在意什么讨厌什么、最近的状态和正在发生的事、和你聊天时要注意什么。
- 只写有依据的内容，推测要说明是推测。过时的近况不要写成现在。
- 600 字以内，分几段，不用标题和列表。
只输出 JSON：{"profile":"..."}`,
    },
    { role: "user", content: `【旧画像】\n${profile || "（还没有）"}\n\n【全部记忆】\n${formatMemories(mems)}` },
  ]);
  if (r.profile?.trim()) {
    setProfile(r.profile.trim());
    setKv("profile_msg_id", String(maxId));
  }
}
