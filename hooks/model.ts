// Pure logic for the panel: no `$`, so it is unit-tested directly.
import type { Run, Todo, TodoStatus } from '../types'

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
  // A command's leading `VAR=value` assignments are noise in a one-line label.
  const bare = tool === 'Bash' && arg ? arg.replace(/^(?:\s*[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '') : arg
  const short = bare ? bare.replace(/\s+/g, ' ').trim().slice(0, 48) : ''
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
  return runs.filter(r => r.status === 'running' || r.status === 'failed' || r.endedAt === undefined || now - r.endedAt < keepMs)
}

/** 950 -> "950", 38_568 -> "38.6k", 1_234_567 -> "1.2M". */
export function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** The stats line: elapsed, ETA, tokens. */
export function stats(run: Run, now: number): { text: string; eta?: string; tokens?: string } {
  const left = etaLeft(run, now)
  const text = clock((run.endedAt ?? now) - run.startedAt)
  return {
    text,
    eta: left !== undefined ? `ETA ${clock(left)}` : undefined,
    tokens: run.tokens ? compact(run.tokens) : undefined,
  }
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

/** Session task timeline: done (including agents already gone), current, upcoming. */
export type Timeline = { done: number; current: number; upcoming: number }

/** Counts every todo the session has seen; `archived` holds the done todos of rows already pruned. */
export function timeline(runs: Run[], archived: number): Timeline {
  const t: Timeline = { done: archived, current: 0, upcoming: 0 }
  for (const r of runs) {
    const cur = currentIndex(r)
    r.todos.forEach((x, i) => {
      if (x.status === 'done') t.done++
      else if (r.status !== 'running') return
      else if (i === cur) t.current++
      else t.upcoming++
    })
  }
  return t
}

/** Splits `width` cells between done, current and upcoming; any non-zero part gets at least one cell. */
export function segments(t: Timeline, width: number): [number, number, number] {
  const parts = [t.done, t.current, t.upcoming]
  const total = parts.reduce((a, b) => a + b, 0)
  if (!total || width <= 0) return [0, 0, 0]
  const exact = parts.map(n => (n / total) * width)
  const cells = parts.map((n, i) => (n ? Math.max(1, Math.round(exact[i])) : 0))
  // Rounding can overshoot or fall short: trim the part rounded up the most, or grow the one cut most.
  let diff = width - cells.reduce((a, b) => a + b, 0)
  while (diff !== 0) {
    const over = cells.map((c, i) => c - exact[i])
    const pick = diff < 0
      ? over.reduce((b, o, i) => (cells[i] > 1 && (b < 0 || o > over[b]) ? i : b), -1)
      : over.reduce((b, o, i) => (parts[i] && (b < 0 || o < over[b]) ? i : b), -1)
    if (pick < 0) break
    cells[pick] += Math.sign(diff)
    diff -= Math.sign(diff)
  }
  return cells as [number, number, number]
}

/**
 * Where the timeline's labels go above the bar: done at the left edge, "now" over the start of
 * the current segment, next flush right. Returns the two gaps, or undefined when they can't fit.
 */
export function labelGaps(left: number, mid: number, right: number, nowAt: number, width: number): [number, number] | undefined {
  const free = width - left - mid - right
  if (free < 2) return undefined
  const start = Math.min(Math.max(nowAt, left + 1), width - right - 1 - mid)
  return [start - left, width - right - start - mid]
}

/** A footer line: something that wants a look. */
export type Alert = { key: string; kind: 'quiet' | 'failed'; name: string; detail: string }

/**
 * What needs attention: failed agents, and running ones with no sign of life
 * (tool call, report, model step) for `quietMs`. Failed first, then the quietest.
 */
export function attention(runs: Run[], now: number, quietMs: number): Alert[] {
  const name = (r: Run) => r.description || r.type
  const failed = runs
    .filter(r => r.status === 'failed')
    .map((r): Alert => ({ key: r.agentId ?? r.id, kind: 'failed', name: name(r), detail: `failed${r.failReason ? ` · ${r.failReason}` : ''}` }))
  const quiet = runs
    .filter(r => r.status === 'running')
    .map(r => ({ r, idle: now - Math.max(r.startedAt, r.lastActivityAt ?? 0, r.lastReportAt ?? 0) }))
    .filter(x => quietMs > 0 && x.idle >= quietMs)
    .sort((x, y) => y.idle - x.idle)
    .map(({ r, idle }): Alert => ({
      key: r.agentId ?? r.id,
      kind: 'quiet',
      name: name(r),
      detail: `quiet ${clock(idle)}${r.currentTool ? ` · ${r.currentTool}` : ''}`,
    }))
  return [...failed, ...quiet]
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

/**
 * A subagent's turn ended. It is finished unless one of its own children still runs:
 * an agent that ends a turn to wait for a background child resumes when the child
 * reports. Todos stay as the agent last reported them; a turn's end proves nothing about them.
 */
export function finishTurn(run: Run, reason: string, at: number, list: Run[]): Run {
  if (run.status !== 'running') return run
  const me = run.agentId ?? run.id
  const waiting = list.some(r => r.parentId === me && r.status === 'running')
  if (waiting) return { ...run, currentTool: undefined }
  if (reason === 'answer') return { ...run, status: 'done', endedAt: at, currentTool: undefined }
  return { ...run, status: 'failed', failReason: reason, endedAt: at, currentTool: undefined }
}

/** Activity from an agent marked done or failed means its turn resumed: running again. Stopped stays stopped. */
export function revive(run: Run): Run {
  return run.status === 'done' || run.status === 'failed' ? { ...run, status: 'running', endedAt: undefined, failReason: undefined } : run
}
