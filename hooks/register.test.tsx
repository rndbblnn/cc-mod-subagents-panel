import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'subagents-panel',
  component: 'Pane',
  requestId: 'subagents',
  surface: 'terminal',
  props: {
    title: 'Subagents',
    isFocused: true,
    bodyColumns: 56,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('a spawned agent is briefed, listed, and its todos open on click', async ($, on) => {
  let prompt = ''
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__subagents-panel__report' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', (_, e) => {
    prompt = e.prompt
    return { agentId: 'a1', model: 'claude-haiku-5-5' }
  })
  on('tool.call', () => ({ result: 'ok' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'do it', description: 'scan repo', subagentType: 'bulk-reader' } as never)
  expect(prompt).toContain('mcp__subagents-panel__report')

  const ui = await $.ui.mount(PANE)
  // No todos yet and nothing to flag: no footer at all.
  expect(await ui.find({ type: 'Text', text: /tasks/ })).toBeFalsy()
  await ui.press({ key: 'row-a1' })
  expect(await ui.find({ type: 'Text', text: /No TODOs reported yet/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeTruthy()
  await ui.unmount()
})

test('the progress bar spans the pane body exactly, on one line', async ($, on) => {
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__subagents-panel__report' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-haiku-5-5' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'narrow', subagentType: 'Explore' } as never)

  // A narrow pane on a wide terminal: the bar follows the pane, not the screen.
  const ui = await $.ui.mount({
    ...PANE,
    viewport: { columns: 200, rows: 50 },
    props: { ...PANE.props, bodyColumns: 30 },
  } as never)
  const barRow = await ui.find({ type: 'Text', text: /[▰▱]{8,}/ })
  const cells = (barRow?.text ?? '').match(/[▰▱]+/)?.[0] ?? ''
  expect(cells.length).toBe(28)
  expect(barRow?.text).not.toContain('\n')
  await ui.unmount()
})

test('a second spawn of the same agent (a resume) keeps its row and clock', async ($, on) => {
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__subagents-panel__report' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-haiku-5-5' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'first', subagentType: 'general-purpose' } as never)
  await $.agent.spawn({ prompt: 'x', description: 'resumed', subagentType: 'general-purpose' } as never)

  const ui = await $.ui.mount(PANE)
  const rows = await ui.findAll({ type: 'Button', text: /general-purpose/ })
  expect(rows.length).toBe(1)
  await ui.unmount()
})

test('the footer shows the task timeline and flags agents that need a look', async ($, on) => {
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__subagents-panel__report' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let n = 0
  on('agent.spawn', () => ({ agentId: `a${++n}`, model: 'claude-haiku-5-5' }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'plan', subagentType: 'general-purpose' } as never)
  await $.agent.spawn({ prompt: 'x', description: 'audit', subagentType: 'general-purpose' } as never)
  await $.tool.call({
    tool: 'mcp__subagents-panel__report',
    agentId: 'a1',
    todos: [
      { text: 'one', status: 'done' },
      { text: 'two', status: 'in_progress' },
      { text: 'three', status: 'pending' },
    ],
  } as never)
  await $.turn.complete({ agentId: 'a2', reason: 'error', answer: '', durationMs: 1, isAborted: false, turnId: 't1' } as never)

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /done/ }))?.text).toMatch(/✓ 1 done\s+▸ 1 now\s+1 next ○/)
  expect((await ui.find({ type: 'Text', text: /─ tasks ─/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Button', key: 'alert-a2' }))?.text).toMatch(/audit\s+failed · error/)
  await ui.unmount()
})

test('an agent without the report tool reports with a PLAN line in its text', async ($, on) => {
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__subagents-panel__report' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let prompt = ''
  on('agent.spawn', (_, e) => {
    prompt = e.prompt
    return { agentId: 'a1', model: 'claude-sonnet-5-5' }
  })
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    return {
    turnId: e.turnId,
    index: e.index,
    answer: 'Reading first.\nPLAN: [x] read schema | [>] patch outbox | [ ] run tests | eta 120',
    toolUses: [],
    stopReason: 'tool_use',
    usage: null,
    }
  } as never)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'outbox', subagentType: 'app-engineer' } as never)
  expect(prompt).toContain('PLAN: [x]')
  // turn.step streams: its hooks run as the stream is read.
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'a1' } as never) as never as AsyncIterable<unknown>) void _

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /patch outbox/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /ETA/ })).toBeTruthy()
  await ui.unmount()

  // It finishes without closing its plan: the open todos show as unclosed, not as current or done.
  await $.turn.complete({ agentId: 'a1', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' } as never)
  const after = await $.ui.mount(PANE)
  expect((await after.find({ type: 'Text', text: /patch outbox/ }))?.text).toMatch(/·\s+patch outbox/)
  expect((await after.find({ type: 'Text', text: /run tests/ }))?.text).toMatch(/·\s+run tests/)
  await after.unmount()
})

test('a stale plan arms one reminder as a step starts; the next tool result carries it', async ($, on) => {
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__subagents-panel__report' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-sonnet-5-5' }))
  on('tool.call', () => ({ result: 'ok' }))
  // Step 0 writes the plan; later steps only work. Each step's tool runs while it streams.
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    yield { kind: 'tool', index: 0, id: `tu${e.index}`, name: 'Read' }
    const answer = e.index === 0 ? 'PLAN: [>] a | [ ] b | eta 60' : ''
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'tool_use', usage: null }
  } as never)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'stale', subagentType: 'app-engineer' } as never)
  const got: string[] = []
  for (let step = 0; step < 7; step++) {
    for await (const chunk of $.turn.step({ turnId: 't1', index: step, model: 'm', messageCount: 1, agentId: 'a1' } as never) as never as AsyncIterable<{ kind: string }>) {
      if (chunk.kind !== 'tool') continue
      for (let i = 0; i < 3; i++) {
        const r = (await $.tool.call({ tool: 'Read', file_path: `/s${step}/${i}`, agentId: 'a1' } as never)) as { context?: readonly string[] }
        got.push(`${step}.${i}:${(r.context ?? []).join('')}`)
      }
    }
  }
  const nudged = got.filter(g => g.includes('[subagents-panel]'))
  // Steps 1-4 do not report; step 5 starts 4 steps after the report: its first call carries it.
  expect(nudged.length).toBe(1)
  expect(nudged[0]).toMatch(/^5\.0:\[subagents-panel\] 4 steps since your last PLAN: line/)
})

test('the panel opens once when an interactive session starts', async ($, on) => {
  let opens = 0
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__subagents-panel__report' } }))
  on('ui.open', () => {
    opens++
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(opens).toBe(1)
  // A hot reload runs session.start again: a pane the person closed stays closed.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(opens).toBe(1)
})

test('no start-up open for a -p run', async ($, on) => {
  let opens = 0
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__subagents-panel__report' } }))
  on('ui.open', () => {
    opens++
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  expect(opens).toBe(0)
})

test('openOnStart off: no pane at start', { options: { openOnStart: false } }, async ($, on) => {
  let opens = 0
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__subagents-panel__report' } }))
  on('ui.open', () => {
    opens++
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(opens).toBe(0)
})
