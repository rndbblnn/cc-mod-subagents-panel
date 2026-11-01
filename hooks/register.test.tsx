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
  on('tool.register', () => ({ value: {} }))
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
  expect((await ui.find({ type: 'Text', text: /1 running/ }))?.text).toContain('1 running')
  await ui.press({ key: 'row-a1' })
  expect(await ui.find({ type: 'Text', text: /No TODOs reported yet/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeTruthy()
  await ui.unmount()
})
