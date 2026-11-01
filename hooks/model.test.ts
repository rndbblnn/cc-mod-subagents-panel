import { describe, expect, test } from 'claude-code/testing'

import type { Run } from '../types'
import { applyReport, bar, clock, describeCall, dueForPing, etaLeft, progress, prune, shortModel, kidsOf, slotOf, blockHeight, absorb, overview, NO_TOTALS, currentIndex, rowHeight, stats, tree } from './model'

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
  test('siblings sort by ETA, longest first; no-ETA then finished below', async () => {
    const rows = tree(
      [
        run({ id: 'short', agentId: 'short', etaAt: 20_000 }),
        run({ id: 'done', agentId: 'done', status: 'done', endedAt: 5_000 }),
        run({ id: 'noeta', agentId: 'noeta', startedAt: 1 }),
        run({ id: 'long', agentId: 'long', etaAt: 90_000 }),
        run({ id: 'kid', agentId: 'kid', parentId: 'short', etaAt: 99_000 }),
      ],
      10_000,
    )
    expect(rows.map(r => `${r.depth}:${r.run.id}`)).toEqual(['0:long', '0:short', '1:kid', '0:noeta', '0:done'])
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

describe('prune', () => {
  test('finished runs leave after keepMs; running and 0 keep', async () => {
    const list = [
      run({ id: 'r', agentId: 'r' }),
      run({ id: 'old', agentId: 'old', status: 'done', endedAt: 0 }),
      run({ id: 'new', agentId: 'new', status: 'stopped', endedAt: 5_000 }),
    ]
    expect(prune(list, 11_000, 10_000).map(r => r.id)).toEqual(['r', 'new'])
    expect(prune(list, 11_000, 0).length).toBe(3)
  })
})

describe('stats', () => {
  test('done/total, elapsed and ETA on one line', async () => {
    const r = run({ todos: [{ text: 'a', status: 'done' }, { text: 'b', status: 'pending' }], etaAt: 75_000 })
    expect(stats(r, 15_000)).toEqual({ text: '1/2 · 0:15', eta: 'ETA 1:00' })
  })
})

describe('todo list', () => {
  const todo = (text: string, status: 'pending' | 'in_progress' | 'done') => ({ text, status })
  test('every todo is a line; current is the one in progress', async () => {
    const r = run({ todos: [todo('a', 'done'), todo('b', 'done'), todo('c', 'in_progress'), todo('d', 'pending')] })
    expect(currentIndex(r)).toBe(2)
    expect(rowHeight(r)).toBe(7)
  })
  test('between todos the next pending one is current; finished agents have none', async () => {
    expect(currentIndex(run({ todos: [todo('a', 'done'), todo('b', 'pending')] }))).toBe(1)
    expect(currentIndex(run({ status: 'done', todos: [todo('a', 'done')] }))).toBe(-1)
  })
  test('no todos: one activity line', async () => {
    expect(rowHeight(run())).toBe(4)
  })
})

describe('overview', () => {
  const todo = (text: string, status: 'pending' | 'in_progress' | 'done') => ({ text, status })
  test('totals survive removal and add what the list still shows', async () => {
    const gone = [
      run({ id: 'x', status: 'done', todos: [todo('a', 'done'), todo('b', 'done')] }),
      run({ id: 'y', status: 'failed', todos: [todo('a', 'done'), todo('b', 'pending')] }),
    ]
    const t = absorb(NO_TOTALS, gone)
    expect(t).toEqual({ done: 1, failed: 1, stopped: 0, todos: 3 })
    const list = [
      run({ id: 'z', status: 'stopped', todos: [todo('a', 'done')] }),
      run({ id: 'r', todos: [todo('a', 'done'), todo('b', 'in_progress')] }),
    ]
    expect(overview(t, list)).toEqual({ done: 1, failed: 1, stopped: 1, todos: 5, running: 1 })
  })
})

describe('shortModel', () => {
  test('family and version, ids and aliases', async () => {
    expect(shortModel('claude-haiku-5-5')).toBe('haiku 5.5')
    expect(shortModel('claude-opus-4-1-20250805')).toBe('opus 4.1')
    expect(shortModel('claude-sonnet-5')).toBe('sonnet 5')
    expect(shortModel('haiku')).toBe('haiku')
  })
})

describe('nesting', () => {
  const todo = (text: string, status: 'pending' | 'in_progress' | 'done') => ({ text, status })
  const parent = run({ id: 'p', agentId: 'p', todos: [todo('plan', 'done'), todo('delegate', 'in_progress'), todo('apply', 'pending')] })
  test('a child sits under the todo it was spawned from, else the current one', async () => {
    expect(slotOf(parent, run({ id: 'k', parentId: 'p', parentTodo: 'plan' }))).toBe(0)
    expect(slotOf(parent, run({ id: 'k', parentId: 'p' }))).toBe(1)
    expect(slotOf(run({ id: 'q' }), run({ id: 'k', parentId: 'q' }))).toBe(-1)
  })
  test('block height counts nested children; unknown parents are roots', async () => {
    const kid = run({ id: 'k', agentId: 'k', parentId: 'p', todos: [todo('scan', 'in_progress')] })
    const orphan = run({ id: 'o', agentId: 'o', parentId: 'gone' })
    const kids = kidsOf([parent, kid, orphan], 0)
    expect((kids.get(undefined) ?? []).map(r => r.id).sort()).toEqual(['o', 'p'])
    expect(blockHeight(parent, kids)).toBe(6 + 4)
  })
})
