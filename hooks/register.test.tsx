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
  // The footer: session overview at the bottom.
  expect((await ui.find({ type: 'Text', text: /agents done/ }))?.text).toMatch(/0 agents done\s+·\s+▰ 0 tasks done\s+·\s+\S 1 running/)
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
