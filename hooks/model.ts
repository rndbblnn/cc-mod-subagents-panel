// Pure logic for the panel: no `$`, so it is unit-tested directly.
import type { Run, Todo, TodoStatus, Totals } from '../types'

export const REPORT_TOOL = 'mcp__subagents-panel__report'

export const BRIEF =
  `\n\n---\nProgress reporting (subagents-panel): right after reading this brief, call \`${REPORT_TOOL}\` ` +
  'with your plan as an ordered `todos` list (3-8 items) and `eta_seconds`, your best guess of the time left. ' +
  'Call it again whenever a TODO changes status, and refresh `eta_seconds` each time. It is cheap and silent.'

export const PING =
  `[subagents-panel] Status check: please call \`${REPORT_TOOL}\` now with your updated ordered todos ` +
  'and a fresh eta_seconds, then carry on.'

export type ReportInput = {
  todos?: { text?: unknown; status?: unknown }[]
  eta_seconds?: number
  note?: string
}

const STATUSES: TodoStatus[] = ['pending', 'in_progress', 'done']

/** Folds a report into a run; fields left out keep their value. */
export function applyReport(run: Run, input: ReportInput, at: number): Run {
  const todos: Todo[] | undefined = Array.isArray(input.todos)
    ? input.todos
        .filter(t => t && typeof t.text === 'string' && t.text.trim())
        .slice(0, 30)
        .map(t => ({
          text: String(t.text).trim(),
          status: STATUSES.includes(t.status as TodoStatus) ? (t.status as TodoStatus) : 'pending',
        }))
    : undefined
  const eta =
    typeof input.eta_seconds === 'number' && isFinite(input.eta_seconds) && input.eta_seconds >= 0
      ? at + Math.round(input.eta_seconds) * 1000
      : undefined
  return {
    ...run,
    todos: todos ?? run.todos,
    etaAt: eta ?? run.etaAt,
    note: typeof input.note === 'string' ? input.note.trim() || undefined : run.note,
    lastReportAt: at,
  }
}

export function progress(run: Run): { done: number; total: number } {
  const total = run.todos.length
  const done = run.todos.filter(t => t.status === 'done').length
  return { done, total }
}

/**
 * Milliseconds left: the agent's own ETA when it gave one, else a linear
 * extrapolation from finished TODOs; undefined when neither is known.
 */
export function etaLeft(run: Run, now: number): number | undefined {
  if (run.status !== 'running') return undefined
  if (run.etaAt !== undefined) return Math.max(0, run.etaAt - now)
  const { done, total } = progress(run)
  if (done === 0 || total === 0 || done >= total) return undefined
  const spent = now - run.startedAt
  return Math.round((spent / done) * (total - done))
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** A bar for known progress, a sweeping pulse when the agent has not reported. */
export function bar(run: Run, now: number, width = 10): string {
  const { done, total } = progress(run)
  if (total > 0) {
    const fill = Math.round((done / total) * width)
    return '▰'.repeat(fill) + '▱'.repeat(width - fill)
  }
  if (run.status !== 'running') return '▱'.repeat(width)
  const pos = Math.floor(now / 250) % (width * 2 - 2)
  const at = pos < width ? pos : width * 2 - 2 - pos
  return Array.from({ length: width }, (_, i) => (i === at ? '▰' : '▱')).join('')
}

export function glyph(run: Run, now: number): string {
  switch (run.status) {
    case 'running':
      return SPIN[Math.floor(now / 100) % SPIN.length]
    case 'done':
      return '✓'
    case 'failed':
      return '✗'
    case 'stopped':
      return '■'
  }
}

/** What the row says the agent is doing. */
export function doing(run: Run): string {
  if (run.status !== 'running') return run.status
  const active = run.todos.find(t => t.status === 'in_progress')
  return run.currentTool ?? active?.text ?? run.note ?? 'thinking…'
}

export type Row = { run: Run; depth: number }

/**
 * Sibling order: running agents with an ETA, longest remaining first; then running
 * ones without an ETA, oldest first; then finished ones, latest ended first.
 */
export function byEta(now: number) {
  const rank = (r: Run) => (r.status !== 'running' ? 2 : etaLeft(r, now) === undefined ? 1 : 0)
  return (a: Run, b: Run): number => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    if (ra === 0) return (etaLeft(b, now) ?? 0) - (etaLeft(a, now) ?? 0)
    if (ra === 1) return a.startedAt - b.startedAt
    return (b.endedAt ?? 0) - (a.endedAt ?? 0)
  }
}

/**
 * Flattens runs into a tree by parent, siblings sorted by `byEta`. A run whose
 * parent is unknown (finished and pruned, or never seen) hangs off the root.
 */
export function tree(runs: Run[], now = 0): Row[] {
  const ids = new Set(runs.map(r => r.agentId ?? r.id))
  const kids = new Map<string | undefined, Run[]>()
  for (const r of runs) {
    const p = r.parentId && ids.has(r.parentId) ? r.parentId : undefined
    kids.set(p, [...(kids.get(p) ?? []), r])
  }
  const out: Row[] = []
  const seen = new Set<string>()
  const walk = (parent: string | undefined, depth: number) => {
    for (const r of [...(kids.get(parent) ?? [])].sort(byEta(now))) {
      const key = r.agentId ?? r.id
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ run: r, depth })
      walk(key, depth + 1)
    }
  }
  walk(undefined, 0)
  return out
}

/** Running agents due a ping: quiet for `afterMs` since start, last report and last ping. */
export function dueForPing(runs: Run[], now: number, afterMs: number): Run[] {
  if (afterMs <= 0) return []
  return runs.filter(r => {
    if (r.status !== 'running' || !r.agentId) return false
    const quietSince = Math.max(r.startedAt, r.lastReportAt ?? 0, r.lastPingAt ?? 0)
    return now - quietSince >= afterMs
  })
}

/** Short "Tool: arg" label for a tool call. */
export function describeCall(tool: string, input: Record<string, unknown>): string {
  const pick = ['command', 'file_path', 'pattern', 'url', 'query', 'description', 'prompt']
  const arg = pick.map(k => input[k]).find(v => typeof v === 'string') as string | undefined
  const name = tool.startsWith('mcp__') ? tool.split('__').slice(1).join(':') : tool
  const short = arg ? arg.replace(/\s+/g, ' ').trim().slice(0, 48) : ''
  return short ? `${name}: ${short}` : name
}

export function summary(runs: Run[]): string {
  const running = runs.filter(r => r.status === 'running').length
  const done = runs.length - running
  return `${running} running · ${done} finished`
}

/** Drops finished runs `keepMs` after they ended; 0 keeps them. Running ones always stay. */
export function prune(runs: Run[], now: number, keepMs: number): Run[] {
  if (keepMs <= 0) return runs
  return runs.filter(r => r.status === 'running' || r.endedAt === undefined || now - r.endedAt < keepMs)
}

/** The stats line: done/total, elapsed, ETA. */
export function stats(run: Run, now: number): { text: string; eta?: string } {
  const { done, total } = progress(run)
  const left = etaLeft(run, now)
  const text = `${total ? `${done}/${total} · ` : ''}${clock((run.endedAt ?? now) - run.startedAt)}`
  return { text, eta: left !== undefined ? `ETA ${clock(left)}` : undefined }
}

/** Index of the current todo: the one in progress, else the next pending while the agent runs; -1 for none. */
export function currentIndex(run: Run): number {
  const at = run.todos.findIndex(t => t.status === 'in_progress')
  if (at >= 0) return at
  return run.status === 'running' ? run.todos.findIndex(t => t.status === 'pending') : -1
}

/** Lines a row takes: name, stats, bar, then every todo (or one activity line). */
export function rowHeight(run: Run): number {
  return 3 + Math.max(1, run.todos.length)
}

export const NO_TOTALS: Totals = { done: 0, failed: 0, stopped: 0, todos: 0 }

/** Folds runs leaving the list into the session totals (running ones are never removed). */
export function absorb(totals: Totals, removed: Run[]): Totals {
  const t = { ...totals }
  for (const r of removed) {
    if (r.status === 'done') t.done++
    else if (r.status === 'failed') t.failed++
    else if (r.status === 'stopped') t.stopped++
    t.todos += r.todos.filter(x => x.status === 'done').length
  }
  return t
}

/** The footer: totals so far plus what the list still shows. */
export function overview(totals: Totals, list: Run[]): Totals & { running: number } {
  const t = absorb(totals, list.filter(r => r.status !== 'running'))
  const live = list.filter(r => r.status === 'running')
  return { ...t, todos: t.todos + live.reduce((n, r) => n + r.todos.filter(x => x.status === 'done').length, 0), running: live.length }
}

/** "claude-haiku-5-5" -> "haiku 5.5", "claude-opus-4-1-20250805" -> "opus 4.1"; aliases pass through. */
export function shortModel(model: string): string {
  const m = model.replace(/^(?:us\.)?anthropic\./, '').replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '')
  const parts = m.match(/^([a-z]+)-(\d+)(?:-(\d+))?/)
  return parts ? `${parts[1]} ${parts[2]}${parts[3] ? `.${parts[3]}` : ''}` : m
}

/** Children by parent key (undefined = roots), each list sorted by `byEta`. Unknown parents count as roots. */
export function kidsOf(runs: Run[], now: number): Map<string | undefined, Run[]> {
  const ids = new Set(runs.map(r => r.agentId ?? r.id))
  const out = new Map<string | undefined, Run[]>()
  for (const r of runs) {
    const p = r.parentId && ids.has(r.parentId) && r.parentId !== (r.agentId ?? r.id) ? r.parentId : undefined
    out.set(p, [...(out.get(p) ?? []), r])
  }
  for (const [k, v] of out) out.set(k, v.sort(byEta(now)))
  return out
}

/**
 * Where a child is drawn in its parent's block: under the todo it was spawned from
 * (matched by text), else under the parent's current todo, else after the list (-1).
 */
export function slotOf(parent: Run, kid: Run): number {
  const at = kid.parentTodo ? parent.todos.findIndex(t => t.text === kid.parentTodo) : -1
  if (at >= 0) return at
  return parent.todos.length ? currentIndex(parent) : -1
}

/** Lines a run's block takes with every descendant drawn inside it. */
export function blockHeight(run: Run, kids: Map<string | undefined, Run[]>, seen = new Set<string>()): number {
  const key = run.agentId ?? run.id
  if (seen.has(key)) return 0
  seen.add(key)
  return rowHeight(run) + (kids.get(key) ?? []).reduce((n, k) => n + blockHeight(k, kids, seen), 0)
}
