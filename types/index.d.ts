export type TodoStatus = 'pending' | 'in_progress' | 'done'

export type Todo = { text: string; status: TodoStatus }

export type RunStatus = 'running' | 'done' | 'failed' | 'stopped'

/** One subagent run as the panel tracks it. */
export type Run = {
  /** agentId when the engine gave one, else the spawning tool_use_id. */
  id: string
  agentId?: string
  /** The spawning agent's id; absent for the main session. */
  parentId?: string
  /** The parent's current todo when this agent was spawned: it is drawn under that todo. */
  parentTodo?: string
  type: string
  description: string
  model: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  /** What it is doing right now, e.g. "Bash: cargo test". */
  currentTool?: string
  toolCalls: number
  /** Context tokens at the agent's latest model step (input + cache + output). */
  tokens?: number
  /** Ordered TODOs, as the agent last reported them. */
  todos: Todo[]
  note?: string
  /** Epoch ms the agent expects to finish, from its last report. */
  etaAt?: number
  lastReportAt?: number
  /** How it reports: the report tool, or PLAN: lines (its tools: allowlist leaves the tool out). */
  reportVia?: 'tool' | 'line'
  /** Model steps finished, and the count when it last reported: how stale its plan is. */
  steps?: number
  stepsAtReport?: number
  /** A stale-plan reminder waits for its next tool result; when one was last armed. */
  nudgeArmed?: boolean
  lastNudgeAt?: number
  lastPingAt?: number
  /** Epoch ms of the agent's last sign of life: a tool call, a report or a model step. */
  lastActivityAt?: number
  /** Why a failed agent's turn ended ('error', 'aborted', 'refusal'), when the engine said. */
  failReason?: string
}

declare module 'claude-code' {
  interface PluginState {
    'subagents-panel': {
      runs: Shaped<Run[]>
      /** The run whose detail view is open; null shows the tree. */
      selected: Shaped<string | null>
      /** True while the message box is open in the detail view. */
      composing: Shaped<boolean>
      /** The panel's clock, ticked each second while something runs. */
      now: Shaped<number>
      /** Done todos of rows already removed, so the timeline keeps counting them. */
      archived: Shaped<number>
    }
  }
}
