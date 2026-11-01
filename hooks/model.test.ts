import { describe, expect, test } from 'claude-code/testing'

import type { Run } from '../types'
import { applyReport, bar, clock, describeCall, dueForPing, etaLeft, progress, tree } from './model'

const run = (over: Partial<Run> = {}): Run => ({
  id: 'a1',
  agentId: 'a1',
  type: 'Explore',
  description: 'find things',
  model: 'haiku',
  status: 'running',
  startedAt: 0,
  toolCalls: 0,
  todos: [],
  ...over,
})

describe('applyReport', () => {
  test('replaces todos in order, sanitises status, sets eta and report time', async () => {
    const r = applyReport(
      run(),
      {
        todos: [
          { text: ' read code ', status: 'done' },
          { text: 'write fix', status: 'in_progress' },
          { text: 'test', status: 'bogus' },
          { text: '   ', status: 'done' },
        ],
        eta_seconds: 30,
      },
      10_000,
    )
    expect(r.todos).toEqual([
      { text: 'read code', status: 'done' },
      { text: 'write fix', status: 'in_progress' },
      { text: 'test', status: 'pending' },
    ])
    expect(r.etaAt).toBe(40_000)
    expect(r.lastReportAt).toBe(10_000)
  })

  test('fields left out keep their value', async () => {
    const before = run({ todos: [{ text: 'x', status: 'pending' }], etaAt: 5_000 })
    const r = applyReport(before, { note: 'busy' }, 1_000)
    expect(r.todos).toEqual(before.todos)
    expect(r.etaAt).toBe(5_000)
    expect(r.note).toBe('busy')
  })
})

describe('eta', () => {
  test('uses the reported eta first', async () => {
    expect(etaLeft(run({ etaAt: 70_000 }), 10_000)).toBe(60_000)
  })
  test('extrapolates from finished todos otherwise', async () => {
    const r = run({
      todos: [
        { text: 'a', status: 'done' },
        { text: 'b', status: 'pending' },
        { text: 'c', status: 'pending' },
      ],
    })
    expect(etaLeft(r, 20_000)).toBe(40_000)
  })
  test('unknown without reports, and none once finished', async () => {
    expect(etaLeft(run(), 5_000)).toBe(undefined)
    expect(etaLeft(run({ status: 'done', etaAt: 9_000 }), 1_000)).toBe(undefined)
  })
})

describe('tree', () => {
  test('nests children under their parent in start order; orphans go to the root', async () => {
    const rows = tree([
      run({ id: 'c', agentId: 'c', parentId: 'p', startedAt: 3 }),
      run({ id: 'p', agentId: 'p', startedAt: 1 }),
      run({ id: 'b', agentId: 'b', parentId: 'p', startedAt: 2 }),
      run({ id: 'o', agentId: 'o', parentId: 'gone', startedAt: 0 }),
    ])
    expect(rows.map(r => `${r.depth}:${r.run.id}`)).toEqual(['0:o', '0:p', '1:b', '1:c'])
  })
})

describe('pings', () => {
  test('only running agents quiet for the whole interval', async () => {
    const list = [
      run({ id: 'quiet', agentId: 'quiet', startedAt: 0 }),
      run({ id: 'fresh', agentId: 'fresh', startedAt: 0, lastReportAt: 80_000 }),
      run({ id: 'pinged', agentId: 'pinged', startedAt: 0, lastPingAt: 50_000 }),
      run({ id: 'done', agentId: 'done', status: 'done' }),
    ]
    expect(dueForPing(list, 100_000, 90_000).map(r => r.id)).toEqual(['quiet'])
    expect(dueForPing(list, 100_000, 0)).toEqual([])
  })
})

describe('labels', () => {
  test('clock, bar, call labels', async () => {
    expect(clock(65_000)).toBe('1:05')
    expect(clock(3_725_000)).toBe('1:02:05')
    const half = run({ todos: [{ text: 'a', status: 'done' }, { text: 'b', status: 'pending' }] })
    expect(bar(half, 0, 4)).toBe('▰▰▱▱')
    expect(progress(half)).toEqual({ done: 1, total: 2 })
    expect(describeCall('Bash', { command: 'cargo   test' })).toBe('Bash: cargo test')
    expect(describeCall('mcp__srv__do', {})).toBe('srv:do')
  })
})
