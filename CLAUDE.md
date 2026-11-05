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
  `cc-mod-subagents-panel`; marketplace is `rndbblnn-mods`.
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
- **Agents with a `tools:` allowlist can't call the report tool**, and a mod can't add it: neither
  `agent.spawn` nor `prompt.compose` lets a hook change an agent's tools (2.1.316). So the brief
  offers a fallback, a `PLAN: [x] a | [>] b | [ ] c | eta 180` line in the agent's text, which the
  `turn.step` hook reads from `result.answer` (`parsePlanLine`). Seen live 2026-11-02 with a Sonnet
  `claude-code-guide` agent: plan and ETA showed within 4 s; it never sent an update in a 19 s run.
- `turn.step` streams: a test's mock must be an `async function*`, and the test must read the
  stream (`for await (… of $.turn.step(…))`) or no hook runs.
- **The engine runs a step's tools while the step still streams** (seen live 2026-11-02: a
  reminder decided inside `tool.call` told an agent "not reported yet" though its PLAN: line was
  in that same step). Reading the plan from `text` chunks before yielding the `tool` chunk did NOT
  fix it live: the engine starts tools from its own stream. So decide nothing mid-step.
- **Stale plans:** a Sonnet agent wrote its PLAN: line once and never updated it (2 runs). Fix:
  as a `turn.step` starts (every earlier step fully read), `nudgeDue` arms a reminder once the
  agent has gone `NUDGE_STEPS` (4) steps without reporting, at most every 30 s; the next tool
  result carries it as `context` (`withNudge`). Steps, not tool calls: parallel lookups are one
  step. `withNudge` runs after the tool, so it must never throw (the gating `.catch` would rerun
  the tool). `reportVia` picks the wording. Status pings via `$.session.send` stay as a backstop,
  still unseen live. Finished runs draw open todos as `unclosed` (`todoMarks`), never as done.

## Check
`claude plugin validate . && claude plugin test .` (47 tests). Live: `claude --plugin-dir .`,
spawn a couple of agents, click a row, try m / e / s.

## Pane seating (learned live, 2026-11-01)
An **unasked** `$.ui.open` (from `agent.spawn`, a timer, `session.start`) is only drawn on a
terminal ≥144 columns (≥110 once the person has opened this pane id by hand); narrower, it
waits undrawn and `isPlaced` is false. So: auto-open falls back to a one-time toast + a
status line entry ("N subagents running · /subagents"). `/subagents` (asked) seats at any width.
- `openOnStart` (default on) opens the pane in `session.start` when `isInteractive`. A hot reload
  re-runs `session.start`, so a `startOpened` `$.state` atom (survives reloads, not sessions)
  makes it once per session — otherwise every edit would reopen a pane the person closed.
- **Size to `e.props.bodyColumns`, never `e.viewport.columns`** — viewport is the whole
  terminal, so a docked pane's content sized to it wraps onto extra lines. Rows:
  `e.props.scroll.bodyRows`. Single-line text: `wrap="truncate"`.
- **`$.session.send` does not throw on failure** — it resolves `{ isDelivered: false, reason }`.
  Always go through `sendTo()`, which toasts the reason. (The first auto-ping test, 2026-11-01,
  reached nobody and nothing said so.) Exception: `background` sends (timer pings) stay silent.
  In auto mode the classifier judges each send like a SendMessage call, and "gave no verdict"
  toasted every `pingSeconds` (seen 2026-11-03).
- **A turn end is not the agent's end** (seen 2026-11-05: three long monitor agents, one row). An
  agent that waits on a background poll or a message ends its turn and the engine lists it as
  `waiting`/`idle`. So `finishTurn` makes a normal end `idle` (live, never pruned, `◌`), and the
  5 s `reconcile` against `$.agent.list()` finishes it on `completed`, or gives a row back to a
  listed agent that has none. Adding `idle` to `RunStatus` needed no shape bump: old values
  are still valid.
- Rows sort by `byElapsed(now)`: longest elapsed first, whatever the status (siblings too).
  The list fills from the top.
- Nesting: at `agent.spawn` the child records the parent's current todo (`parentTodo`);
  the list renders recursively (`block()`), each child under that todo (`slotOf`), and
  fits whole root blocks (`blockHeight`) top first.
- Footer (`timeline`, `attention`, `segments`, `labelGaps` in model.ts): task timeline across the
  session (`archived` atom keeps done todos of pruned rows), "▼ N more agents not shown", and
  alerts (failed; running with no tool call/report/model step for `pingSeconds`). Rendered only
  when it has something to say; fitting reserves its height first. Failed rows are never
  auto-pruned. A `turn.complete` test event needs `answer`, `durationMs`, `isAborted`, `turnId`.
- **Shape bump + hot reload drops in-flight rows (seen 2026-11-02, cause inferred).** Agents spawned
  in the same turn as an edit that bumped `runs-1`→`runs-2` got "no panel row" for every report:
  their rows were written under the old shape, and the reloaded module started from `[]`. Spawns
  after the reload were fine. When testing a shape change live, spawn test agents in a later turn.
- **Pane height vs `scroll.bodyRows`** (2.1.316, measured live from screenshots): with nothing
  running (so this mod's status line is hidden) a docked pane shows `bodyRows + 1` rows; with the
  status line up it shows exactly `bodyRows`. `room` follows that, or the footer either floats a
  row high or loses its bar row. Pinning the footer with `height="100%"` + a `flexGrow` spacer does
  not work: the pane body has no fixed height. Re-measure after a Claude Code upgrade.
