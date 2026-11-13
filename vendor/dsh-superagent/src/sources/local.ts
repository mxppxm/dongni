/**
 * Local inbox Source: a person drops task files into a directory on this machine and the agent picks them up.
 *
 * The tree under `directory` (default `~/.dsh/state/superagent/inbox`):
 *   pending/<task>.json    a task waiting to be taken in; moved to `archive` once received. A file that names an
 *                          earlier task in `thread` is a follow-up on that task's Thread, not a new task
 *   archive/<task>.json    tasks already taken in, kept for thread context
 *   replies/<task>/<id>.md every reply the agent sent for that task
 *
 * Task files are the whole transport, so this Source needs no account, no network and no CLI.
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { ContextMessage, ContextPart, ContextPartName, SourceKind } from './kind.ts'

/* ── configuration ─────────────────────────────────────────────────── */

const ConfigSchema = z.object({
  /** Inbox root; empty means `~/.dsh/state/superagent/inbox`. */
  directory: z.string().default(''),
  pollSeconds: z.number().int().min(1).max(3600).default(5),
}).strict()
export type LocalConfig = z.infer<typeof ConfigSchema>

/** One task file: what to do, and where to do it. */
const TaskSchema = z.looseObject({
  id: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  text: z.string().min(1),
  from: z.string().min(1).default('owner'),
  cwd: z.string().optional(),
  at: z.string().optional(),
  /** The id of an earlier task this file follows up on: a changed requirement, an answer to the agent's question, a stop. */
  thread: z.string().regex(/^[a-zA-Z0-9._-]+$/).optional(),
})
export type LocalTask = z.infer<typeof TaskSchema>

/** The inbox root for a configuration. */
export const inboxRoot = (config: LocalConfig): string =>
  config.directory || join(homedir(), '.dsh', 'state', 'superagent', 'inbox')

/* ── domain mapping ────────────────────────────────────────────────── */

/**
 * One task file becomes one Trigger, addressed directly by the person who wrote it. A new task opens its own Thread; a
 * follow-up joins the Thread of the task it names, so it reaches that task's Ticket and its replies land in the same
 * `replies/<task>` directory.
 */
export function localTrigger(task: LocalTask, root: string): Trigger {
  const thread = task.thread ?? task.id
  return {
    id: key('local', task.id),
    source: 'local',
    threads: [{ source: 'local', id: thread }],
    actor: { source: 'local', id: task.from },
    human: true,
    addressed: 'direct',
    at: task.at ?? new Date().toISOString(),
    text: task.text,
    channel: { source: 'local', thread: `local:${thread}`, address: { task: thread, root } },
    meta: { task: thread, root, ...task.thread ? { message: task.id } : {}, ...task.cwd ? { cwd: task.cwd } : {} },
  }
}

/* ── replies ───────────────────────────────────────────────────────── */

/** Writes each reply as a file, keyed by the message id, so a retry overwrites rather than duplicates. */
export async function sendLocal(message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { task, root } = message.channel.address
  if (!task || !root) throw new Error('Missing local reply target')
  const directory = join(root, 'replies', task)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, `${message.id}.md`),
    `<!-- ${message.kind} · ticket ${message.ticketId ?? '-'} -->\n${message.text}\n`)
  return 'sent'
}

/** Reads a task's Thread: the task itself first, then its follow-ups and every reply in time order. */
function readThread(task: string, root: string, fallback: Trigger): ContextPart {
  const messages: ContextMessage[] = []
  let original: LocalTask | undefined
  for (const directory of [join(root, 'archive'), join(root, 'pending')]) {
    try {
      original = TaskSchema.parse(JSON.parse(readFileSync(join(directory, `${task}.json`), 'utf8')))
      break
    } catch { /* the task sits in the other directory, or its file is gone */ }
  }
  messages.push({ id: task, from: original?.from ?? fallback.actor.id, at: original?.at ?? fallback.at, text: original?.text ?? fallback.text })

  const later: { at: number; message: ContextMessage }[] = []
  // Follow-ups already taken in: archived task files that name this task as their thread.
  try {
    const directory = join(root, 'archive')
    for (const name of readdirSync(directory).filter(name => name.endsWith('.json'))) {
      try {
        const path = join(directory, name)
        const followUp = TaskSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
        if (followUp.thread !== task) continue
        const at = followUp.at ? Date.parse(followUp.at) : statSync(path).mtimeMs
        later.push({ at, message: { id: followUp.id, from: followUp.from, at: followUp.at ?? '', text: followUp.text } })
      } catch { /* not a task file */ }
    }
  } catch { /* nothing archived yet */ }
  try {
    const directory = join(root, 'replies', task)
    for (const name of readdirSync(directory).filter(name => name.endsWith('.md'))) {
      const body = readFileSync(join(directory, name), 'utf8')
      later.push({ at: statSync(join(directory, name)).mtimeMs,
        message: { id: basename(name, '.md'), from: 'local', at: '', text: body.replace(/^<!--[^>]*-->\n/, '').trimEnd() } })
    }
  } catch { /* no replies yet */ }
  messages.push(...later.sort((left, right) => left.at - right.at).map(item => item.message))
  return { messages, body: { messages } }
}

/* ── the kind ──────────────────────────────────────────────────────── */

export const localKind: SourceKind<LocalConfig> = {
  kind: 'local',
  title: { zh: '本地收件箱', en: 'Local inbox' },
  description: {
    zh: '接收本地目录里的任务文件。不需要账号、网络或命令行工具。',
    en: 'Takes in task files dropped into a local directory. No account, network or CLI needed.',
  },
  schema: ConfigSchema,
  fields: [
    { key: 'directory', type: 'text', advanced: true,
      label: { zh: '收件目录', en: 'Inbox directory' },
      hint: { zh: '留空使用 ~/.dsh/state/superagent/inbox。任务是 pending/ 里的 .json 文件。', en: 'Empty means ~/.dsh/state/superagent/inbox. Tasks are .json files in pending/.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 1, max: 3600,
      label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['local'],

  scope: () => ({ listened: true, observed: true, row: 'inbox' }),

  channel: {
    allowed: address => Boolean(address.task && address.root),
    send: (_host, message) => sendLocal(message),
    link: address => ({ url: '', label: { zh: `本地任务 ${address.task ?? ''}`, en: `Local task ${address.task ?? ''}` } }),
  },

  threadContext: {
    messageId: trigger => String(trigger.meta.message ?? trigger.meta.task ?? ''),
    read: async (_commands, trigger, _part: ContextPartName, _cursor, _config) =>
      readThread(String(trigger.meta.task ?? ''), String(trigger.meta.root ?? ''), trigger),
  },

  find: query => ({
    threads: (query.match(/\bt-[a-zA-Z0-9._-]+/g) ?? []).map(id => `local:${id}`),
    terms: [],
  }),

  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]),
    }).strict(),
    fields: [{
      key: 'allowed', type: 'rows', label: { zh: '能派活的本地用户', en: 'Local users who may assign work' },
      hint: { zh: '任务文件里的 from 字段要在这个名单里，否则评估会拒绝。', en: 'The `from` field of a task file must be on this list, or the assessment refuses it.' },
      columns: [
        { key: 'id', type: 'text', label: { zh: '用户名', en: 'User' } },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
      ],
    }],
    explicit: {
      zh: '名单里的人往收件箱丢一个任务文件。',
      en: 'Someone on the list drops a task file into the inbox.',
    },
    rows: () => [{
      id: 'inbox', label: { zh: '本地收件箱', en: 'Local inbox' }, note: { zh: '任务文件', en: 'Task files' },
      cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false },
    }],
  },

  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_LOCAL_CWD',
        description: { zh: '本地任务要求的工作目录；工单不是本地来的时为空',
          en: 'The working directory a local task names; empty when the ticket did not come from the local inbox' } },
      { key: 'DSH_SUPERAGENT_LOCAL_TASK',
        description: { zh: '本地任务的 id；工单不是本地来的时为空',
          en: 'The local task id; empty when the ticket did not come from the local inbox' } },
    ],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_LOCAL_CWD: trigger?.source === 'local' ? String(trigger.meta.cwd ?? '') : '',
      DSH_SUPERAGENT_LOCAL_TASK: trigger?.source === 'local' ? String(trigger.meta.task ?? '') : '',
    }),
  },
}

/* ── the loop ──────────────────────────────────────────────────────── */

/** Moves a taken-in task file out of `pending`, keeping its name. */
function archive(path: string, root: string, suffix: string): void {
  const directory = join(root, 'archive')
  mkdirSync(directory, { recursive: true })
  const name = basename(path).replace(/\.json$/, '') + suffix
  try { renameSync(path, join(directory, name)) } catch { /* another round already moved it */ }
}

/** Reads every task in `pending`, takes it in, and archives it. Unreadable files are archived as `.bad`. */
export async function pollInbox(ctx: SourceContext, config: LocalConfig, signal: AbortSignal): Promise<{ read: number; bad: number }> {
  const root = inboxRoot(config)
  const pending = join(root, 'pending')
  mkdirSync(pending, { recursive: true })
  let read = 0
  let bad = 0
  for (const file of readdirSync(pending).filter(name => name.endsWith('.json')).sort()) {
    if (signal.aborted) throw new Error('The local Source stopped during the read')
    const path = join(pending, file)
    let task: LocalTask
    try {
      task = TaskSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      bad += 1
      archive(path, root, '.bad')
      continue
    }
    const trigger = localTrigger(task, root)
    await ctx.receive(trigger)
    read += 1
    // A follow-up joins a Thread its task already described.
    if (!task.thread) ctx.threads.describe(threadKey(trigger.threads[0]!), {
      label: `本地任务 ${task.id}`,
      facts: {
        task: { label: { zh: '任务', en: 'Task' }, value: task.id },
        ...task.cwd ? { cwd: { label: { zh: '目录', en: 'Directory' }, value: task.cwd } } : {},
      },
    })
    archive(path, root, '.json')
  }
  return { read, bad }
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup resolves the GitHub account first; until then nothing is dispatched anywhere.
  if (!ctx.configured()) {
    ctx.report('local', health('paused', 'setupPending'))
    return
  }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<LocalConfig>('local')
    if (!config) ctx.report('local', health('paused', 'sourceOff'))
    else {
      try {
        const { read, bad } = await pollInbox(ctx, config, signal)
        failures = 0
        ctx.report('local', { state: 'ready', detail: `${read} task(s), ${bad} unreadable`, at: new Date().toISOString() })
      } catch (error) {
        failures += 1
        if (!signal.aborted && failures >= 3) {
          ctx.report('local', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((config?.pollSeconds ?? 5) * 1000, undefined, { signal }).catch(() => {})
  }
}

export const name = 'dsh-superagent-local'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(localKind), 'local: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = watch(sourceContext(ctx.orchestrator, localKind), controller.signal)
      .catch((error: unknown) => { sourceContext(ctx.orchestrator, localKind).report('local', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
