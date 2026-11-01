import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run } from '../types'
import {
  BRIEF,
  PING,
  REPORT_TOOL,
  applyReport,
  bar,
  clock,
  describeCall,
  doing,
  dueForPing,
  etaLeft,
  glyph,
  progress,
  prune,
  absorb,
  overview,
  NO_TOTALS,
  currentIndex,
  rowHeight,
  stats,
  compact,
  shortModel,
  finishTurn,
  revive,
  kidsOf,
  slotOf,
  blockHeight,
  tree,
  type ReportInput,
} from './model'

// Bump a shape tag when that value's fields change: it declines what an older
// version stored, which outlives a reload.
const runs = atom({ plugin: 'subagents-panel', key: 'runs' } as const, [], { shape: 'runs-1' })
const selected = atom({ plugin: 'subagents-panel', key: 'selected' } as const, null, { shape: 'selected-1' })
const composing = atom({ plugin: 'subagents-panel', key: 'composing' } as const, false, { shape: 'composing-1' })
const now = atom({ plugin: 'subagents-panel', key: 'now' } as const, 0, { shape: 'now-1' })
const totals = atom({ plugin: 'subagents-panel', key: 'totals' } as const, NO_TOTALS, { shape: 'totals-1' })

const PANE = 'subagents'
const TITLE = 'Subagents'
const KEEP = 100

const keyOf = (r: Run) => r.agentId ?? r.id

/** The bar: yellow while it runs, green once done, red if it failed; stopped draws dim. */
const barColor = (r: Run) => (r.status === 'done' ? 'green' : r.status === 'failed' ? 'red' : 'yellow')
const statusColor = (r: Run) =>
  r.status === 'running' ? 'yellow' : r.status === 'done' ? 'green' : r.status === 'failed' ? 'red' : 'gray'

/** Opens the pane; resolves whether a surface draws it now. */
async function openPane($: EngineInterface, focus = false): Promise<boolean> {
  await update($, now, () => Date.now())
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: 56, backgroundColor: 'transparent', ...(focus ? { focus: true as const } : {}) })
  return opened.isPlaced
}

// An unasked pane waits undrawn on a narrow terminal (below 144 columns, 110 once
// the person has opened it): say so once, and keep a status line entry instead.
let hinted = false

async function togglePane($: EngineInterface): Promise<boolean> {
  if ((await $.ui.panes()).some(p => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return false
  }
  await openPane($, true)
  return true
}

async function patch($: EngineInterface, agentId: string, fn: (r: Run) => Run): Promise<boolean> {
  let hit = false
  await update($, runs, list =>
    list.map(r => {
      if (r.agentId !== agentId) return r
      hit = true
      return fn(r)
    }),
  )
  return hit
}

/**
 * Sends `text` to a running agent. `$.session.send` does not throw on a failed
 * delivery, it answers `{ isDelivered: false, reason }`: say so in a toast.
 */
async function sendTo($: EngineInterface, run: Run, text: string, what: string, quietOnSuccess = false): Promise<boolean> {
  if (!run.agentId) return false
  try {
    const sent = await $.session.send({ to: { agentId: run.agentId }, text })
    if (!sent.isDelivered) {
      await $.ui.toast(`${what} to ${run.type} not delivered: ${sent.reason}`)
      return false
    }
    if (!quietOnSuccess) await $.ui.toast(`${what} sent to ${run.type}`)
    return true
  } catch (err) {
    await $.ui.toast(`${what} to ${run.type} failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

async function stopRun($: EngineInterface, run: Run): Promise<string> {
  if (!run.agentId) return 'no agent id to stop'
  try {
    await $.tool.call({ tool: 'TaskStop', task_id: run.agentId } as never)
    await patch($, run.agentId, r => ({ ...r, status: 'stopped', endedAt: Date.now(), currentTool: undefined }))
    return 'stopped'
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await $.ui.toast(`Could not stop ${run.type}: ${msg}`)
    return msg
  }
}

export const register: Register = (on, options) => {
  // Options arrive as set in /config or settings.json: numbers, numeric strings, or unset.
  const num = (v: unknown, d: number) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
    return Number.isFinite(n) && n >= 0 ? n : d
  }
  const autoOpen = options.autoOpen !== false && options.autoOpen !== 'false'
  const pingMs = num(options.pingSeconds, 90) * 1000
  const keepMs = num(options.keepFinishedSeconds, 10) * 1000

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'report',
      description:
        'For subagents: report your plan and progress to the Subagents panel. Send the FULL ordered todo list each time ' +
        '(each item {text, status: pending|in_progress|done}) and eta_seconds, your best estimate of the time left. ' +
        'Call it right after reading your brief, whenever a todo changes status, and when asked for a status check.',
      inputSchema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'Your ordered todos, 3-8 items, first to last.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'A few words.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
              },
              required: ['text', 'status'],
            },
          },
          eta_seconds: { type: 'integer', minimum: 0, description: 'Estimated seconds until you finish.' },
          note: { type: 'string', description: 'Optional: what you are doing right now, a few words.' },
        },
      },
      // Listed up front, not behind ToolSearch: agents do not go looking for it.
      isDeferred: false,
    })
    await $.command.register({
      name: 'subagents',
      description: 'Show or hide the Subagents panel (`/subagents open` brings it forward, `/subagents clear` drops finished rows)',
    })

    // One tick a second: moves clocks and spinners, and pings quiet agents.
    let tick = 0
    $.clock.every(1000, () => {
      void (async () => {
        const at = Date.now()
        let list = await read($, runs)
        // Finished rows leave `keepFinishedSeconds` after they end.
        const kept = prune(list, at, keepMs)
        if (kept.length !== list.length) {
          const gone = list.filter(r => !kept.includes(r))
          await update($, totals, t => absorb(t, gone))
          list = await update($, runs, rs => prune(rs, at, keepMs))
          const sel = await read($, selected)
          if (sel && !list.some(r => keyOf(r) === sel)) {
            await update($, selected, () => null)
            await update($, composing, () => false)
          }
          await update($, now, () => at)
        }
        const running = list.filter(r => r.status === 'running').length
        $.ui.status(running ? `⚙ ${running} subagent${running > 1 ? 's' : ''} running · /subagents` : undefined)
        if (!running) return
        await update($, now, () => at)
        if (++tick % 5 !== 0) return
        for (const r of dueForPing(list, at, pingMs)) {
          await patch($, r.agentId!, x => ({ ...x, lastPingAt: at }))
          await sendTo($, r, PING, 'Status ping', true)
        }
        // Reconcile with the engine's own view: catches stops and kills we did not see.
        try {
          const live = new Map((await $.agent.list()).map(a => [a.id, a.status]))
          await update($, runs, rs =>
            rs.map((r): Run => {
              const s = r.agentId ? live.get(r.agentId) : undefined
              if (r.status !== 'running' || !s) return r
              if (s === 'completed') return { ...r, status: 'done', endedAt: at, currentTool: undefined }
              if (s === 'failed') return { ...r, status: 'failed', endedAt: at, currentTool: undefined }
              if (s === 'killed') return { ...r, status: 'stopped', endedAt: at, currentTool: undefined }
              return r
            }),
          )
        } catch {
          // Listing is best effort.
        }
      })()
    })
    return started
  })

  on('command.run', { command: 'subagents' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg === 'open') {
      await openPane($, true)
      return { text: 'Subagents panel opened.' }
    }
    if (arg === 'clear') {
      const gone = (await read($, runs)).filter(r => r.status !== 'running')
      await update($, totals, t => absorb(t, gone))
      await update($, runs, list => list.filter(r => r.status === 'running'))
      await update($, selected, () => null)
      return { text: 'Finished subagents cleared.' }
    }
    return { text: (await togglePane($)) ? 'Subagents panel opened.' : 'Subagents panel closed.' }
  })

  // Every subagent gets the reporting brief and a row.
  on('agent.spawn', async ($, e, next) => {
    const briefed = e.prompt.includes(REPORT_TOOL) ? e : { ...e, prompt: e.prompt + BRIEF }
    const started = await next(briefed)
    if (started.deny !== undefined) return started

    const parent = e.parentAgentId ? (await read($, runs)).find(r => r.agentId === e.parentAgentId) : undefined
    const parentCur = parent ? currentIndex(parent) : -1
    const run: Run = {
      id: started.agentId ?? e.tool_use_id,
      agentId: started.agentId,
      parentId: e.parentAgentId,
      parentTodo: parent && parentCur >= 0 ? parent.todos[parentCur].text : undefined,
      type: e.subagentType || 'agent',
      description: e.description,
      model: started.model,
      status: 'running',
      startedAt: Date.now(),
      toolCalls: 0,
      todos: [],
    }
    await update($, runs, list => [...list.filter(r => keyOf(r) !== keyOf(run)), run].slice(-KEEP))
    if (autoOpen && !(await openPane($)) && !hinted) {
      hinted = true
      await $.ui.toast('Subagents running: type /subagents to show the panel (terminal too narrow to open it by itself)')
    }
    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: REPORT_TOOL }, async ($, e) => {
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report to the panel' }
    const hit = await patch($, agentId, r => applyReport(revive(r), e as unknown as ReportInput, Date.now()))
    return { result: hit ? 'ok' : `ignored: no panel row for agent ${agentId}` }
  }).catch(() => ({ result: 'ok (panel update failed; carry on)' }))

  // Tracks what each subagent is doing; the main session's calls pass untouched.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (!agentId || e.tool === REPORT_TOOL) return next(e)
    const label = describeCall(e.tool, e as unknown as Record<string, unknown>)
    await patch($, agentId, r => ({ ...revive(r), currentTool: label, toolCalls: r.toolCalls + 1 }))
    try {
      return await next(e)
    } finally {
      await patch($, agentId, r => (r.currentTool === label ? { ...r, currentTool: undefined } : r))
    }
  }).catch(($, e, next) => next(e))

  // Each model step of a subagent: its context size, shown as tokens on the stats line.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const u = result.usage
    if (e.agentId && u) {
      const tokens =
        (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0)
      if (tokens > 0) await patch($, e.agentId, r => ({ ...revive(r), tokens }))
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) {
      const at = Date.now()
      const list = await read($, runs)
      await patch($, e.agentId, r => finishTurn(r, e.reason, at, list))
    }
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // Not every surface draws a text box; there the message control is hidden.
    const Input = 'Input' in ui ? ui.Input : undefined
    const list = await read($, runs)
    const at = Math.max(await read($, now), Date.now() - 1000)
    const sel = await read($, selected)
    // The pane's own body, inside its frame, not the terminal (`viewport` is the whole screen).
    const width = Math.max(12, e.props.bodyColumns ?? 56)
    const room = Math.max(4, (e.props.scroll?.bodyRows ?? 24) - 1)

    const pick = sel ? list.find(r => keyOf(r) === sel) : undefined
    if (pick) {
      const isComposing = await read($, composing)
      const { done, total } = progress(pick)
      const left = etaLeft(pick, at)
      const back = () => {
        void update($, selected, () => null)
        void update($, composing, () => false)
      }
      return (
        <Box flexDirection="column">
          <Box>
            <Button key="back" label="← back" hotkey="b" plain onPress={back} />
          </Box>
          <Text bold>
            {glyph(pick, at)} {pick.type} <Text dimColor> {shortModel(pick.model)}</Text>
          </Text>
          <Text dimColor>{pick.description}</Text>
          <Text dimColor>
            {total ? `${done}/${total} · ` : ''}
            {clock((pick.endedAt ?? at) - pick.startedAt)}
            {left !== undefined ? <Text color="cyan"> · ETA {clock(left)}</Text> : null}
            {pick.tokens ? <Text dimColor> · {compact(pick.tokens)}</Text> : null}
          </Text>
          <Text color={barColor(pick)} dimColor={pick.status === 'stopped'} wrap="truncate">
            {bar(pick, at, width)}
          </Text>
          <Text dimColor>{doing(pick)}</Text>
          <Text> </Text>
          <Text bold>TODOs</Text>
          {pick.todos.length === 0 && <Text dimColor>No TODOs reported yet.</Text>}
          {pick.todos.map((t, i) => (
            <Text
              color={t.status === 'in_progress' ? 'cyan' : undefined}
              dimColor={t.status === 'done'}
              strikethrough={t.status === 'done'}
            >
              {String(i + 1).padStart(2)}. {t.status === 'done' ? '✓' : t.status === 'in_progress' ? '▸' : '○'} {t.text}
            </Text>
          ))}
          <Text> </Text>
          {pick.status === 'running' && pick.agentId && !isComposing && (
            <Box gap={2}>
              {Input && (
                <Button key="msg" label="message" hotkey="m" plain onPress={() => void update($, composing, () => true)} />
              )}
              <Button key="ping" label="ask for ETA" hotkey="e" plain onPress={() => void sendTo($, pick, PING, 'ETA request')} />
              <Button key="stop" label="stop" hotkey="s" plain onPress={() => void stopRun($, pick)} />
            </Box>
          )}
          {isComposing && pick.agentId && Input && (
            <Input
              key="compose"
              label={`Message ${pick.type}`}
              placeholder="what should it know or do?"
              submitLabel="send"
              autoFocus
              onSubmit={(value: string) => {
                const text = value.trim()
                void update($, composing, () => false)
                if (text) void sendTo($, pick, text, 'Message')
              }}
            />
          )}
        </Box>
      )
    }

    const kids = kidsOf(list, at)
    const roots = kids.get(undefined) ?? []
    // Blocks differ in height (todos, nested children): keep the roots that fit, top first.
    const shown: Run[] = []
    const FOOTER = 2
    let used = (list.length ? 0 : 1) + FOOTER
    for (const r of roots) {
      const h = blockHeight(r, kids)
      if (used + h > room && shown.length) break
      used += h
      shown.push(r)
    }
    // One agent's block: header, stats, bar, todos; each child sits under the todo that launched it.
    const block = (run: Run, depth: number, seen: Set<string>): JSX.Element => {
      seen.add(keyOf(run))
      const st = stats(run, at)
      const indent = '  '.repeat(Math.min(depth, 6))
      // 100% of the body: whatever the indent and the two-cell gutter leave.
      const barWidth = Math.max(4, width - indent.length - 2)
      const mine = (kids.get(keyOf(run)) ?? []).filter(k => !seen.has(keyOf(k)))
      const under = (slot: number) => mine.filter(k => slotOf(run, k) === slot).map(k => block(k, depth + 2, seen))
      const cur = currentIndex(run)
      return (
        <Box flexDirection="column">
          <Button key={`row-${keyOf(run)}`} plain onPress={() => void update($, selected, () => keyOf(run))}>
            {indent}
            <Text color={statusColor(run)}>{glyph(run, at)}</Text> <Text bold>{run.type}</Text>
            <Text dimColor>  {shortModel(run.model)}</Text>
          </Button>
          <Text wrap="truncate">
            {indent}  <Text dimColor>{st.text}</Text>
            {st.eta ? <Text color="cyan"> · {st.eta}</Text> : ''}
            {st.tokens ? <Text dimColor> · {st.tokens}</Text> : ''}
          </Text>
          <Text wrap="truncate">
            {indent}  <Text color={barColor(run)} dimColor={run.status === 'stopped'}>{bar(run, at, barWidth)}</Text>
          </Text>
          {run.todos.length === 0 ? (
            <Text dimColor wrap="truncate-end">
              {indent}  └ {doing(run)}
            </Text>
          ) : (
            run.todos.map((t, i) => (
              <Box flexDirection="column">
                {i === cur ? (
                  <Text wrap="truncate-end">
                    {indent}  <Text color="yellow">▸</Text> <Text color="text">{t.text}</Text>
                    {run.currentTool ? <Text dimColor> · {run.currentTool}</Text> : ''}
                  </Text>
                ) : t.status === 'done' ? (
                  <Text wrap="truncate-end">
                    {indent}  <Text color="green">✓</Text> <Text dimColor>{t.text}</Text>
                  </Text>
                ) : (
                  <Text dimColor wrap="truncate-end">
                    {indent}  ○ {t.text}
                  </Text>
                )}
                {under(i)}
              </Box>
            ))
          )}
          {under(-1)}
        </Box>
      )
    }
    const o = overview(await read($, totals), list)
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
    // Blank lines push the footer to the bottom of the body.
    const pad = Math.max(0, room - used)
    const footer = (
      <Box flexDirection="column">
        {Array.from({ length: pad }, () => (
          <Text> </Text>
        ))}
        <Text dimColor wrap="truncate">{'─'.repeat(width)}</Text>
        <Text wrap="truncate">
          <Text color="green">✓ </Text>
          <Text bold>{o.done}</Text>
          <Text dimColor>{o.done === 1 ? ' agent done' : ' agents done'}</Text>
          <Text dimColor>  ·  </Text>
          <Text color="green">▰ </Text>
          <Text bold>{o.todos}</Text>
          <Text dimColor>{o.todos === 1 ? ' task done' : ' tasks done'}</Text>
          {o.running ? (
            <Text>
              <Text dimColor>  ·  </Text>
              <Text color="yellow">{glyph({ status: 'running' } as Run, at)} </Text>
              <Text bold>{o.running}</Text>
              <Text dimColor> running</Text>
            </Text>
          ) : (
            ''
          )}
          {o.failed ? <Text color="red">{`  ·  ✗ ${plural(o.failed, 'failure')}`}</Text> : ''}
          {o.stopped ? <Text color="gray">{`  ·  ■ ${o.stopped} stopped`}</Text> : ''}
        </Text>
      </Box>
    )
    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>No subagents yet.</Text>}
        {shown.map(r => block(r, 0, new Set()))}
        {footer}
      </Box>
    )
  })
}
