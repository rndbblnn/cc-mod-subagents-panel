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
