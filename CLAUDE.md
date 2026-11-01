# subagents-panel — notes for Claude

A Claude Code **mod** (hooks module plugin). Load the `plugin-authoring` skill before changing it: it
names this build's API types file (`claude-code.d.ts`, ~14k lines — grep it, never read it whole).

## Layout
- `hooks/model.ts` — pure logic (tree, progress, ETA, ping schedule, labels). No `$`. Unit-tested.
- `hooks/register.tsx` — wires model to the engine: `agent.spawn` (brief + row), `tool.call`
  (current tool; the `report` tool), `turn.complete` (done/failed), 1 s clock (spinners, pings,
  reconcile with `$.agent.list()`), `ui.render` Pane `subagents`.
- `types/index.d.ts` — `$.state` contract. Change a value's fields → bump its `shape` tag in
  `register.tsx`, or old stored values meet new code after a reload.

## Gotchas learned building it (2026-11-01)
- **Plugin names can't start with `claude-`** (reserved). Hence plugin `subagents-panel` in repo
  `cc-mod-subagent-view`; marketplace is `rndbblnn-mods`.
- `atom({ plugin, key })` must use **string literals**, not a `const P` — the validator's scan
  can't read variables.
- Hooks on `agent.spawn` / `tool.call` are *gating*: each has `.catch(($, e, next) => next(e))`
  so a panel bug never blocks a spawn or a tool. Keep that.
- `Input` isn't on every surface: guard with `'Input' in ui`.
- No `tsc` installed: type-check with a throwaway tsconfig **outside** the mod folder that
  includes the skill's `claude-code.d.ts` + `hooks/**` + `types/**`, `jsx: react`,
  `jsxFactory: h`, then `npx -y -p typescript@5.6.3 tsc -p <that>`. Once the engine has loaded
  the mod, `.claude-plugin/types/` (gitignored) holds the types and `tsc -p .` works.
- Stop uses `$.tool.call({ tool: 'TaskStop', task_id: agentId })` — not documented as a mod
  API; if the engine refuses, the toast says why.
- Agents with a `tools:` allowlist in `~/.claude/agents/*.md` must list
  `mcp__subagents-panel__report`, or they cannot report.

## Check
`claude plugin validate . && claude plugin test .` (20 tests). Live: `claude --plugin-dir .`,
spawn a couple of agents, click a row, try m / e / s.

## Pane seating (learned live, 2026-11-01)
An **unasked** `$.ui.open` (from `agent.spawn`, a timer, `session.start`) is only drawn on a
terminal ≥144 columns (≥110 once the person has opened this pane id by hand); narrower, it
waits undrawn and `isPlaced` is false. So: auto-open falls back to a one-time toast + a
status line entry ("N subagents running · /subagents"). `/subagents` (asked) seats at any width.
- **Size to `e.props.bodyColumns`, never `e.viewport.columns`** — viewport is the whole
  terminal, so a docked pane's content sized to it wraps onto extra lines. Rows:
  `e.props.scroll.bodyRows`. Single-line text: `wrap="truncate"`.
- **`$.session.send` does not throw on failure** — it resolves `{ isDelivered: false, reason }`.
  Always go through `sendTo()`, which toasts the reason. (The first auto-ping test, 2026-11-01,
  reached nobody and nothing said so.)
- Rows sort by `byEta(now)`: running with ETA (longest first), running without, finished.
  The list fills from the top.
- Nesting: at `agent.spawn` the child records the parent's current todo (`parentTodo`);
  the list renders recursively (`block()`), each child under that todo (`slotOf`), and
  fits whole root blocks (`blockHeight`) top first.
