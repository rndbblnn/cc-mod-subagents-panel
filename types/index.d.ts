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
  type: string
  description: string
  model: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  /** What it is doing right now, e.g. "Bash: cargo test". */
  currentTool?: string
  toolCalls: number
  /** Ordered TODOs, as the agent last reported them. */
  todos: Todo[]
  note?: string
  /** Epoch ms the agent expects to finish, from its last report. */
  etaAt?: number
  lastReportAt?: number
  lastPingAt?: number
}

/** Session totals of agents that already left the list. */
export type Totals = { done: number; failed: number; stopped: number; todos: number }

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
      /** Finished agents and their done todos, kept after their rows leave. */
      totals: Shaped<Totals>
    }
  }
}
