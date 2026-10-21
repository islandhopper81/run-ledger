export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type ModelTotals = Tokens & {
  requests: number
  /** Dollars at the dated prices, or null when the model has no price. */
  costUsd: number | null
}

export type RowKind = 'run' | 'agent'

export type RowStatus =
  | 'running'
  | 'done'
  | 'aborted'
  | 'error'
  | 'refused'
  | 'pending'
  | 'idle'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'killed'

/** One main-loop turn (kind run) or one subagent (kind agent). */
export type Row = {
  id: string
  kind: RowKind
  label: string
  /** The plugin that started it where known, else you or the model. */
  source: string
  type?: string
  /** The model a subagent was started on. */
  model?: string
  /** The run a subagent was started in, kept after that run ends. */
  runId?: string
  status: RowStatus
  startedAt: number
  endedAt?: number
  latestAction: string
  /** Requests that returned usage, each counted once. */
  requests: number
  /** Requests that ended with no response, so no usage was reported. */
  noUsage: number
  byModel: Record<string, ModelTotals>
}

export type Step = {
  key: string
  rowId: string
  model: string
  tokens: Tokens
  costUsd: number | null
  at: number
}

export type RecStatus = 'pending' | 'ok' | 'unavailable' | 'error'

export type Rec = {
  id: string
  rowId: string
  label: string
  status: RecStatus
  reason?: string
  recommended?: string
  confidence?: number
  probabilities?: Record<string, number>
  taskComplexity?: number
  reasoningRequired?: number
  ms?: number
  jevInputTokens: number
  jevOutputTokens: number
  at: number
}

export type Ledger = {
  rows: Row[]
  steps: Step[]
  recs: Rec[]
  now: number
}

export type View = {
  tab: 'runs' | 'agents' | 'advice'
  detail: string | null
  /** The last surface and pane events, newest last, for /run-ledger. */
  log?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'run-ledger': { ledger: Ledger; view: View }
  }
}
