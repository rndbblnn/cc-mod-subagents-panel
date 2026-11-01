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
  summary,
  tree,
  type ReportInput,
} from './model'

// Bump a shape tag when that value's fields change: it declines what an older
// version stored, which outlives a reload.
const runs = atom({ plugin: 'subagents-panel', key: 'runs' } as const, [], { shape: 'runs-1' })
const selected = atom({ plugin: 'subagents-panel', key: 'selected' } as const, null, { shape: 'selected-1' })
const composing = atom({ plugin: 'subagents-panel', key: 'composing' } as const, false, { shape: 'composing-1' })
const now = atom({ plugin: 'subagents-panel', key: 'now' } as const, 0, { shape: 'now-1' })

const PANE = 'subagents'
const TITLE = 'Subagents'
const KEEP = 100

const keyOf = (r: Run) => r.agentId ?? r.id

/** Opens the pane; resolves whether a surface draws it now. */
async function openPane($: EngineInterface, focus = false): Promise<boolean> {
  await update($, now, () => Date.now())
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: 56, ...(focus ? { focus: true as const } : {}) })
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
  const autoOpen = options.autoOpen !== false
  const pingMs = Math.max(0, Number(options.pingSeconds ?? 90)) * 1000

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
        const list = await read($, runs)
        const running = list.filter(r => r.status === 'running').length
        $.ui.status(running ? `⚙ ${running} subagent${running > 1 ? 's' : ''} running · /subagents` : undefined)
        if (!running) return
        const at = Date.now()
        await update($, now, () => at)
        if (++tick % 5 !== 0) return
        for (const r of dueForPing(list, at, pingMs)) {
          await patch($, r.agentId!, x => ({ ...x, lastPingAt: at }))
          try {
            await $.session.send({ to: { agentId: r.agentId! }, text: PING })
          } catch {
            // The agent may have just ended; the next tick sees it.
          }
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

    const run: Run = {
      id: started.agentId ?? e.tool_use_id,
      agentId: started.agentId,
      parentId: e.parentAgentId,
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
    const hit = await patch($, agentId, r => applyReport(r, e as unknown as ReportInput, Date.now()))
    return { result: hit ? 'ok' : `ignored: no panel row for agent ${agentId}` }
  }).catch(() => ({ result: 'ok (panel update failed; carry on)' }))

  // Tracks what each subagent is doing; the main session's calls pass untouched.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (!agentId || e.tool === REPORT_TOOL) return next(e)
    const label = describeCall(e.tool, e as unknown as Record<string, unknown>)
    await patch($, agentId, r => ({ ...r, currentTool: label, toolCalls: r.toolCalls + 1 }))
    try {
      return await next(e)
    } finally {
      await patch($, agentId, r => (r.currentTool === label ? { ...r, currentTool: undefined } : r))
    }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) {
      await patch($, e.agentId, r =>
        r.status !== 'running'
          ? r
          : {
              ...r,
              status: e.reason === 'answer' ? 'done' : 'failed',
              endedAt: Date.now(),
              currentTool: undefined,
              todos: e.reason === 'answer' ? r.todos.map(t => ({ ...t, status: 'done' as const })) : r.todos,
            },
      )
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
    const width = e.viewport?.columns ?? 56
    const room = Math.max(4, (e.viewport?.rows ?? 24) - 4)

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
            {glyph(pick, at)} {pick.type} <Text dimColor>· {pick.model}</Text>
          </Text>
          <Text dimColor>{pick.description}</Text>
          <Text>
            {bar(pick, at, 16)} {total ? `${done}/${total}` : ''}  {clock((pick.endedAt ?? at) - pick.startedAt)}
            {left !== undefined ? <Text color="cyan">  ETA {clock(left)}</Text> : null}
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
              <Button key="ping" label="ask for ETA" hotkey="e" plain onPress={() => void $.session.send({ to: { agentId: pick.agentId! }, text: PING })} />
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
                if (text) void $.session.send({ to: { agentId: pick.agentId! }, text })
              }}
            />
          )}
        </Box>
      )
    }

    const rows = tree(list)
    const nameW = Math.max(10, Math.min(22, width - 34))
    return (
      <Box flexDirection="column">
        <Text dimColor>{list.length ? summary(list) : 'No subagents yet.'}</Text>
        {rows.slice(-room).map(({ run, depth }) => {
          const { done, total } = progress(run)
          const left = etaLeft(run, at)
          const indent = '  '.repeat(Math.min(depth, 4))
          const name = `${indent}${run.type}`.slice(0, nameW).padEnd(nameW)
          const color =
            run.status === 'running' ? 'cyan' : run.status === 'done' ? 'green' : run.status === 'failed' ? 'red' : 'yellow'
          return (
            <Box flexDirection="column">
              <Button key={`row-${keyOf(run)}`} plain onPress={() => void update($, selected, () => keyOf(run))}>
                <Text color={color}>{glyph(run, at)}</Text> {name} {bar(run, at, 8)}
                <Text dimColor> {total ? `${done}/${total} ` : ''}{clock((run.endedAt ?? at) - run.startedAt)}</Text>
                {left !== undefined ? <Text color="cyan"> ~{clock(left)}</Text> : ''}
              </Button>
              {run.status === 'running' && (
                <Text dimColor>
                  {indent}  └ {doing(run).slice(0, Math.max(10, width - indent.length - 6))}
                </Text>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
