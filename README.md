# subagents-panel

A Claude Code mod: a live panel of **every** subagent beside the chat, drawn as a tree by parent.

```
3 running · 2 finished
⠹ Explore           ▰▰▰▱▱▱▱▱ 2/5 1:10 ~1:45
   └ Grep: refresh_token
⠼ boss-of-me        ▱▱▰▱▱▱▱▱ 4:02
   └ Bash: cargo test
  ⠧ bulk-reader     ▰▰▰▰▰▱▱▱ 3/5 0:42 ~0:28
  ✓ Plan            ▰▰▰▰▰▰▰▰ 4/4 2:31
✗ app-spy-researcher ▱▱▱▱▱▱▱▱ 0:55
```

- **Rows**: status, agent type, progress bar (filled from TODOs; a sweeping pulse until the agent reports), done/total, elapsed, ETA, and what it is doing right now (current tool call, else its active TODO).
- **ETA**: the agent's own `eta_seconds` estimate, else extrapolated from finished TODOs.
- **Ordered TODOs**: every subagent is briefed to call `mcp__subagents-panel__report` with its full ordered todo list and ETA. A running agent that stays quiet for `pingSeconds` (default 90) is messaged to report again.
- **Click a row** (or tab to it + enter) for its detail view: numbered TODOs, plus controls: `m` message the agent, `e` ask for a fresh ETA, `s` stop it, `b` back.

## Commands

- `/subagents` toggles the panel; `/subagents open` brings it forward; `/subagents clear` drops finished rows.

## Settings (`/config`, or `~/.claude/settings.json`)

```json
{ "pluginConfigs": { "subagents-panel": { "options": { "autoOpen": true, "pingSeconds": 90 } } } }
```

- `autoOpen` (default `true`): open the panel when any subagent starts. Self-opening needs a terminal ≥144 columns (≥110 after you have opened it once with `/subagents`); narrower, the status line shows the running count and `/subagents` opens it.
- `pingSeconds` (default `90`, `0` = off): message an agent that has not reported for this long.

## Install

```
/plugin marketplace add rndbblnn/claude-subagents-panel
/plugin install subagents-panel@rndbblnn-mods
```

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .          # a session with this checkout loaded
```

Pure logic lives in `hooks/model.ts` (unit-tested in `hooks/model.test.ts`); `hooks/register.tsx` wires it to the engine.

## Troubleshooting

- **Agent definitions with a `tools:` allowlist** must list `mcp__subagents-panel__report`, or that agent cannot report (its row then shows only the pulse and current tool).
- **Stop does nothing**: stop goes through the `TaskStop` tool; a toast shows the engine's reason when it refuses.
- The plugin name cannot start with `claude-` (reserved by Claude Code), hence `subagents-panel` in a repo called `claude-subagents-panel`.

## Credits

Inspired by [savvy-progress](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress) by johnnyvizz (MIT). Written from scratch; no code copied.

MIT licensed.
