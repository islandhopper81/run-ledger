import { expect, test } from 'claude-code/testing'

import { costOf, fmtCost } from '../hooks/cost'
import { EMPTY, actualModel, mergeAgents, recordStep, rowCost, totalCost, upsertRow } from '../hooks/ledger'
import { buildRequest, parseAdvice } from '../hooks/jev'
import { renderReport } from '../hooks/report'
import type { Row } from '../types'

const run: Row = {
  id: 't1',
  kind: 'run',
  label: 'fix the bug',
  source: 'you',
  status: 'running',
  startedAt: 0,
  latestAction: '',
  requests: 0,
  noUsage: 0,
  byModel: {},
}

const usage = (model: string, n = 1000) => ({
  model,
  input_tokens: n,
  output_tokens: n,
  cache_read_input_tokens: n,
  cache_creation_input_tokens: n,
})

const step = (key: string, model: string) => ({
  key,
  rowId: 't1',
  isAgent: false,
  requestModel: model,
  usage: usage(model),
  at: 1,
})

test('costs use the dated prices and say unknown without one', async () => {
  // Sonnet 5.5: $2 in, $10 out, $0.20 cache read; write assumed 1.25x input.
  const usd = costOf('claude-sonnet-5-5', { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 })
  expect(Math.abs((usd ?? 0) - (2 + 10 + 0.2 + 2.5))).toBeLessThan(1e-9)
  expect(costOf('some-new-model', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull()
  expect(fmtCost(null)).toBe('unknown')
  expect(fmtCost(1.234, true)).toBe('$1.23+unknown')
})

test('a request is counted once however many times it is reported', async () => {
  let l = upsertRow(EMPTY, run)
  l = recordStep(l, step('t1:0', 'claude-haiku-5-5'))
  l = recordStep(l, step('t1:0', 'claude-haiku-5-5'))
  l = recordStep(l, step('t1:1', 'claude-haiku-5-5'))

  expect(l.rows[0]?.requests).toBe(2)
  expect(l.steps).toHaveLength(2)
  expect(l.rows[0]?.byModel['claude-haiku-5-5']?.input).toBe(2000)
})

test('a request with no response adds no cost and is counted apart', async () => {
  let l = upsertRow(EMPTY, run)
  l = recordStep(l, { ...step('t1:0', 'claude-haiku-5-5'), usage: null })

  expect(l.rows[0]?.requests).toBe(0)
  expect(l.rows[0]?.noUsage).toBe(1)
  expect(rowCost(l.rows[0] as Row).isEmpty).toBe(true)
})

test('costs split by the model that answered and unknown stays unknown', async () => {
  let l = upsertRow(EMPTY, run)
  l = recordStep(l, step('t1:0', 'claude-haiku-5-5'))
  l = recordStep(l, step('t1:1', 'claude-opus-5-5'))
  l = recordStep(l, step('t1:2', 'mystery-model'))
  const row = l.rows[0] as Row
  const c = rowCost(row)

  expect(Object.keys(row.byModel)).toHaveLength(3)
  expect(c.hasUnknown).toBe(true)
  expect(c.usd).toBeGreaterThan(0)
  expect(totalCost(l).hasUnknown).toBe(true)
  expect(actualModel(row)).toBeDefined()
})

test('subagents keep their source plugin and original run', async () => {
  let l = upsertRow(EMPTY, { ...run, id: 'a1', kind: 'agent', runId: 't1', source: 'my-plugin' })
  l = mergeAgents(l, [{ id: 'a1', description: 'scan files', type: 'Explore', status: 'completed', spawnedBy: 'my-plugin' }], 5)
  const a = l.rows[0] as Row

  expect(a.runId).toBe('t1')
  expect(a.source).toBe('my-plugin')
  expect(a.status).toBe('completed')
  expect(a.endedAt).toBe(5)
})

test('the Jev request carries the task, models, prices, budget and past results', async () => {
  const body = buildRequest({
    task: 'rename a variable',
    current: 'claude-sonnet-5-5',
    spentUsd: 0.5,
    past: [{ task: 'earlier', model: 'claude-haiku-5-5', result: 'done', costUsd: 0.01 }],
  })
  const env = body.state.environment

  expect(body.state.request).toBe('rename a variable')
  expect(env.available_models.map(m => m.id)).toContain('claude-haiku-5-5')
  expect(env.available_models[0]?.usd_per_million_input).toBe(0.1)
  expect(env.budget_usd.spent_so_far).toBe(0.5)
  expect(env.past_results).toHaveLength(1)
  expect(Object.keys(body.questions.model.criteria)).toHaveLength(3)
})

test('Jev replies are read, and odd ones are refused', async () => {
  const ok = parseAdvice({
    answers: {
      model: { choice: 'claude-haiku-5-5', confidence: 0.9, probabilities: { 'claude-haiku-5-5': 0.9 } },
      task_complexity: { score: 2 },
      reasoning_required: { score: 1 },
    },
    usage: { input_tokens: 120, output_tokens: 3 },
  })

  expect(ok?.recommended).toBe('claude-haiku-5-5')
  expect(ok?.inputTokens).toBe(120)
  expect(parseAdvice({ answers: {} })).toBeNull()
  expect(parseAdvice(null)).toBeNull()
})

test('the text report lists costs, models, advice and says unknown where it is', async () => {
  expect(renderReport(EMPTY)).toContain('none recorded yet')
  expect(renderReport(EMPTY)).toContain('Session cost: unknown')

  let l = upsertRow(EMPTY, run)
  l = recordStep(l, step('t1:0', 'claude-haiku-5-5'))
  l = recordStep(l, step('t1:1', 'mystery-model'))
  const text = renderReport({
    ...l,
    recs: [{ id: 'r', rowId: 't1', label: 'fix the bug', status: 'ok', recommended: 'claude-haiku-5-5', confidence: 0.9, jevInputTokens: 10, jevOutputTokens: 1, at: 1 }],
  })

  expect(text).toContain('not subscription charges')
  expect(text).toContain('+unknown')
  expect(text).toContain('advised claude-haiku-5-5 (90% confident)')
  expect(text).toContain('Retries are not reported')
})
