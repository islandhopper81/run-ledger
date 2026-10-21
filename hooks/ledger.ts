import type { Ledger, ModelTotals, Rec, Row, RowStatus, Step, Tokens } from '../types'
import { NO_TOKENS, addTokens, costOf } from './cost'

export const EMPTY: Ledger = { rows: [], steps: [], recs: [], now: 0 }

const MAX_ROWS = 100
const MAX_STEPS = 500
const MAX_RECS = 100

export const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

export const cut = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s

export function upsertRow(l: Ledger, row: Row): Ledger {
  const has = l.rows.some(r => r.id === row.id)
  const rows = has
    ? l.rows.map(r => (r.id === row.id ? { ...r, ...row, byModel: r.byModel, requests: r.requests, noUsage: r.noUsage } : r))
    : [...l.rows, row].slice(-MAX_ROWS)

  return { ...l, rows }
}

export const patchRow = (l: Ledger, id: string, patch: Partial<Row>): Ledger => ({
  ...l,
  rows: l.rows.map(r => (r.id === id ? { ...r, ...patch } : r)),
})

export function setRec(l: Ledger, rec: Rec): Ledger {
  const has = l.recs.some(r => r.id === rec.id)
  const recs = has
    ? l.recs.map(r => (r.id === rec.id ? rec : r))
    : [...l.recs, rec].slice(-MAX_RECS)

  return { ...l, recs }
}

export const lastRunning = (l: Ledger): Row | undefined =>
  [...l.rows].reverse().find(r => r.kind === 'run' && r.status === 'running')

export type StepInput = {
  key: string
  rowId: string
  isAgent: boolean
  requestModel: string
  /** What the API reported; null when no response arrived. */
  usage: {
    model: string
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
  } | null
  at: number
}

const stubRow = (s: StepInput): Row => ({
  id: s.rowId,
  kind: s.isAgent ? 'agent' : 'run',
  label: s.isAgent ? 'subagent' : 'turn',
  source: s.isAgent ? 'unknown' : 'you',
  status: 'running',
  startedAt: s.at,
  latestAction: '',
  requests: 0,
  noUsage: 0,
  byModel: {},
})

/** Counts one request once: a step key already recorded changes nothing. */
export function recordStep(l: Ledger, s: StepInput): Ledger {
  if (l.steps.some(x => x.key === s.key)) return l
  const base = l.rows.some(r => r.id === s.rowId)
    ? l
    : { ...l, rows: [...l.rows, stubRow(s)].slice(-MAX_ROWS) }

  if (s.usage === null) {
    return patchRow(base, s.rowId, {
      noUsage: (base.rows.find(r => r.id === s.rowId)?.noUsage ?? 0) + 1,
    })
  }

  const model = s.usage.model || s.requestModel
  const tokens: Tokens = {
    input: s.usage.input_tokens,
    output: s.usage.output_tokens,
    cacheRead: s.usage.cache_read_input_tokens,
    cacheWrite: s.usage.cache_creation_input_tokens,
  }
  const costUsd = costOf(model, tokens)
  const step: Step = { key: s.key, rowId: s.rowId, model, tokens, costUsd, at: s.at }
  const row = base.rows.find(r => r.id === s.rowId) as Row
  const prev: ModelTotals | undefined = row.byModel[model]
  const next: ModelTotals = {
    ...addTokens(prev ?? NO_TOKENS, tokens),
    requests: (prev?.requests ?? 0) + 1,
    costUsd: costUsd === null ? null : (prev?.costUsd ?? 0) + costUsd,
  }

  return {
    ...patchRow(base, s.rowId, {
      requests: row.requests + 1,
      byModel: { ...row.byModel, [model]: next },
    }),
    steps: [...base.steps, step].slice(-MAX_STEPS),
  }
}

/** Dollars over the known prices, and whether any model had none. */
export function rowCost(r: Row): { usd: number; hasUnknown: boolean; isEmpty: boolean } {
  const models = Object.values(r.byModel)
  let usd = 0
  let hasUnknown = false
  for (const m of models) {
    if (m.costUsd === null) hasUnknown = true
    else usd += m.costUsd
  }

  return { usd, hasUnknown, isEmpty: models.length === 0 }
}

export function totalCost(l: Ledger): { usd: number; hasUnknown: boolean } {
  let usd = 0
  let hasUnknown = false
  for (const r of l.rows) {
    const c = rowCost(r)
    usd += c.usd
    hasUnknown ||= c.hasUnknown
  }

  return { usd, hasUnknown }
}

/** The model that answered most of a row's requests, or the one it started on. */
export function actualModel(r: Row): string | undefined {
  const top = Object.entries(r.byModel).sort((a, b) => b[1].requests - a[1].requests)[0]

  return top?.[0] ?? r.model
}

const ENDED: RowStatus[] = ['completed', 'failed', 'killed', 'done', 'aborted', 'error', 'refused']

export const isEnded = (s: RowStatus): boolean => ENDED.includes(s)

export type AgentLike = {
  id: string
  description: string
  type: string
  status: string
  spawnedBy?: string
}

const STATUSES: RowStatus[] = ['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'killed']

/** Brings agent rows in line with `$.agent.list()`; rows it has not seen are added. */
export function mergeAgents(l: Ledger, list: readonly AgentLike[], now: number): Ledger {
  let next = l
  for (const a of list) {
    const status = (STATUSES as string[]).includes(a.status) ? (a.status as RowStatus) : 'running'
    const row = next.rows.find(r => r.id === a.id)
    if (row === undefined) {
      next = upsertRow(next, {
        id: a.id,
        kind: 'agent',
        label: cut(oneLine(a.description), 60),
        source: a.spawnedBy ?? 'model or you',
        type: a.type,
        status,
        startedAt: now,
        endedAt: isEnded(status) ? now : undefined,
        latestAction: '',
        requests: 0,
        noUsage: 0,
        byModel: {},
      })
    } else {
      next = patchRow(next, a.id, {
        status,
        source: a.spawnedBy ?? row.source,
        endedAt: row.endedAt ?? (isEnded(status) ? now : undefined),
      })
    }
  }

  return next
}

export function spentUsd(l: Ledger): number {
  return totalCost(l).usd
}
