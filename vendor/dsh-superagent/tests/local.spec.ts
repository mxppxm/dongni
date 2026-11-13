import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OutboundMessage } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { inboxRoot, localKind, localTrigger, pollInbox, sendLocal, type LocalConfig } from '../src/sources/local.ts'

const made: string[] = []
const scratch = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-local-'))
  made.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of made.splice(0)) if (existsSync(directory)) rmSync(directory, { recursive: true, force: true })
})

/** Drops a task file into `pending`, as `scripts/dshtask` does. */
const drop = (root: string, task: Record<string, unknown>, name = String(task.id)): string => {
  const pending = join(root, 'pending')
  mkdirSync(pending, { recursive: true })
  const path = join(pending, `${name}.json`)
  writeFileSync(path, JSON.stringify(task))
  return path
}

/** The parts of SourceContext the local Source reaches for. */
const context = (received: unknown[] = [], described: unknown[] = []) => ({
  receive: vi.fn(async (trigger: unknown) => { received.push(trigger); return { stored: true } }),
  threads: { describe: vi.fn((...args: unknown[]) => described.push(args)) },
}) as unknown as SourceContext
const config = (directory: string): LocalConfig => ({ directory, pollSeconds: 5 })

describe('local source', () => {
  it('turns a task file into a trigger on its own thread, addressed directly by the person who wrote it', () => {
    const trigger = localTrigger({ id: 't-1', text: '把除零改成抛 RangeError', from: 'owner', cwd: '/tmp/app' }, '/tmp/inbox')
    expect(trigger).toMatchObject({
      source: 'local',
      threads: [{ source: 'local', id: 't-1' }],
      actor: { source: 'local', id: 'owner' },
      human: true,
      addressed: 'direct',
      text: '把除零改成抛 RangeError',
      channel: { address: { task: 't-1', root: '/tmp/inbox' } },
      meta: { task: 't-1', root: '/tmp/inbox', cwd: '/tmp/app' },
    })
    expect(trigger.id).toMatch(/^[0-9a-f]{32}$/)
    expect(localTrigger({ id: 't-2', text: 'other', from: 'owner' }, '/tmp/inbox').id).not.toBe(trigger.id)
    // A task without a directory carries no cwd, so the executor works in the ticket directory instead.
    expect(localTrigger({ id: 't-2', text: 'x', from: 'owner' }, '/tmp/inbox').meta).not.toHaveProperty('cwd')
  })

  it('puts a follow-up on the thread of the task it names, as its own trigger, replying into that task\'s directory', async () => {
    const first = localTrigger({ id: 't-1', text: 'build it', from: 'owner' }, '/tmp/inbox')
    const followUp = localTrigger({ id: 't-1-f1', thread: 't-1', text: '改成全身的', from: 'owner' }, '/tmp/inbox')
    expect(followUp.id).not.toBe(first.id)
    expect(followUp).toMatchObject({
      threads: [{ source: 'local', id: 't-1' }],
      human: true,
      addressed: 'direct',
      channel: { thread: 'local:t-1', address: { task: 't-1', root: '/tmp/inbox' } },
      meta: { task: 't-1', message: 't-1-f1' },
    })
    expect(localKind.threadContext!.messageId!(followUp)).toBe('t-1-f1')
    expect(localKind.threadContext!.messageId!(first)).toBe('t-1')

    // Once both are taken in, the thread reads as the task, then the follow-up.
    const root = scratch()
    drop(root, { id: 't-1', text: 'build it', from: 'owner', at: '2026-11-01T00:00:00.000Z' })
    drop(root, { id: 't-1-f1', thread: 't-1', text: '改成全身的', from: 'owner', at: '2026-11-01T00:05:00.000Z' })
    const received: { threads: { id: string }[] }[] = []
    const described: unknown[] = []
    await pollInbox(context(received, described), config(root), new AbortController().signal)
    expect(received.map(trigger => trigger.threads[0]!.id)).toEqual(['t-1', 't-1'])
    expect(described).toHaveLength(1)
    const part = await localKind.threadContext!.read!({} as never, localTrigger({ id: 't-1', text: 'build it', from: 'owner' }, root), 'thread' as never, undefined as never, config(root) as never)
    expect((part.body as { messages: { id: string }[] }).messages.map(message => message.id)).toEqual(['t-1', 't-1-f1'])
  })

  it('takes every task in pending, archives it, and counts an unreadable file without stopping the round', async () => {
    const root = scratch()
    drop(root, { id: 't-1', text: 'first', from: 'owner', cwd: '/tmp/app' })
    drop(root, { id: 't-2', text: 'second', from: 'owner' })
    writeFileSync(join(root, 'pending', 'broken.json'), '{ not json')

    const received: unknown[] = []
    const described: unknown[] = []
    const result = await pollInbox(context(received, described), config(root), new AbortController().signal)

    expect(result).toEqual({ read: 2, bad: 1 })
    expect(received).toHaveLength(2)
    expect(described).toHaveLength(2)
    expect(readdirSync(join(root, 'pending'))).toEqual([])
    expect(readdirSync(join(root, 'archive')).sort()).toEqual(['broken.bad', 't-1.json', 't-2.json'])
  })

  it('reads no task twice, so a second round finds nothing', async () => {
    const root = scratch()
    drop(root, { id: 't-1', text: 'only', from: 'owner' })
    const received: unknown[] = []
    await pollInbox(context(received), config(root), new AbortController().signal)
    const again = await pollInbox(context(received), config(root), new AbortController().signal)
    expect(again).toEqual({ read: 0, bad: 0 })
    expect(received).toHaveLength(1)
  })

  it('writes each reply as a file named by its message id, overwriting rather than duplicating on a retry', async () => {
    const root = scratch()
    const message = (id: string, text: string, kind: OutboundMessage['kind']): OutboundMessage =>
      ({ id, kind, text, ticketId: 'k1', channel: { source: 'local', thread: 'local:t-1', address: { task: 't-1', root } } })
    expect(await sendLocal(message('m1', '好的', 'acknowledgement'))).toBe('sent')
    expect(await sendLocal(message('m2', '改好了', 'reply'))).toBe('sent')
    expect(await sendLocal(message('m2', '改好了，覆盖一次', 'reply'))).toBe('sent')

    const directory = join(root, 'replies', 't-1')
    expect(readdirSync(directory).sort()).toEqual(['m1.md', 'm2.md'])
    expect(readFileSync(join(directory, 'm2.md'), 'utf8')).toBe('<!-- reply · ticket k1 -->\n改好了，覆盖一次\n')
  })

  it('reads a thread as the task first, then its replies in the order they were sent', async () => {
    const root = scratch()
    drop(root, { id: 't-1', text: '原任务', from: 'owner' })
    await pollInbox(context(), config(root), new AbortController().signal)
    const message = (id: string, text: string, kind: OutboundMessage['kind']): OutboundMessage =>
      ({ id, kind, text, channel: { source: 'local', thread: 'local:t-1', address: { task: 't-1', root } } })
    await sendLocal(message('m1', '第一条', 'acknowledgement'))
    await sendLocal(message('m2', '第二条', 'reply'))

    const trigger = localTrigger({ id: 't-1', text: '原任务', from: 'owner' }, root)
    const part = await localKind.threadContext!.read(undefined as never, trigger, 'thread', undefined, config(root))
    expect(part.messages?.map(entry => entry.text)).toEqual(['原任务', '第一条', '第二条'])
  })

  it('names the messages it posts as the agent and only accepts an address that carries a task and a root', () => {
    const trigger = localTrigger({ id: 't-9', text: 'x', from: 'owner' }, '/tmp/inbox')
    expect(localKind.threadContext!.messageId(trigger)).toBe('t-9')
    const allowed = localKind.channel!.allowed!
    const config: LocalConfig = { directory: '/tmp/inbox', pollSeconds: 5 }
    expect(allowed({ task: 't-9', root: '/tmp/inbox' }, config)).toBe(true)
    expect(allowed({ task: 't-9' }, config)).toBe(false)
    expect(allowed({ root: '/tmp/inbox' }, config)).toBe(false)
  })

  it('defaults the inbox under the state directory and leaves the admission to the allowed list', () => {
    expect(inboxRoot({ directory: '', pollSeconds: 5 })).toMatch(/\.dsh\/state\/superagent\/inbox$/)
    expect(inboxRoot(config('/tmp/somewhere'))).toBe('/tmp/somewhere')
    expect(localKind.scope!({ meta: {} }, config('/tmp/inbox'))).toMatchObject({ listened: true, row: 'inbox' })
    const policy = localKind.policy!
    expect(policy.schema.parse({})).toEqual({ allowed: [] })
    // Nobody outside the list can originate work, which is why the list has to name someone.
    expect(policy.rows!(policy.schema.parse({}))[0]!.cells).toEqual({ listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false })
  })
})
