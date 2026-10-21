import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ledger, Rec, Row, RowStatus, View } from '../types'
import { ASSUMPTIONS, PRICES_AS_OF, fmtCost, fmtElapsed, fmtTokens } from './cost'
import { JEV_URL, buildRequest, parseAdvice } from './jev'
import { renderReport } from './report'
import type { Past } from './jev'
import {
  EMPTY,
  actualModel,
  cut,
  lastRunning,
  mergeAgents,
  oneLine,
  patchRow,
  recordStep,
  rowCost,
  setRec,
  spentUsd,
  totalCost,
  upsertRow,
} from './ledger'

type Engine = EngineInterface

const PANE = 'run-ledger'
const ledgerRef = { plugin: 'run-ledger', key: 'ledger' } as const
const ledger = atom(ledgerRef, EMPTY)
const view = atom({ plugin: 'run-ledger', key: 'view' } as const, {
  tab: 'runs',
  detail: null,
} as View)

const RUN_STATUS: Record<string, RowStatus> = {
  answer: 'done',
  aborted: 'aborted',
  refusal: 'refused',
  error: 'error',
}

const mark = (s: RowStatus): string =>
  s === 'running' ? '…' : s === 'done' || s === 'completed' ? '✓' : s === 'idle' || s === 'waiting' ? '·' : s === 'pending' ? '○' : '✗'

const note = ($: Engine, text: string) =>
  update($, view, v => ({ ...v, log: [...(v.log ?? []), text].slice(-8) }))

/** Asks Jev for a model and records the answer. Never changes what runs. */
async function recommend(
  $: Engine,
  rowId: string,
  label: string,
  task: string,
  current: string,
): Promise<void> {
  const id = `rec:${rowId}`
  const at = await $.clock.now()
  const rec: Rec = { id, rowId, label, status: 'pending', jevInputTokens: 0, jevOutputTokens: 0, at }
  await update($, ledger, l => setRec(l, rec))

  const finish = (patch: Partial<Rec>) => update($, ledger, l => setRec(l, { ...rec, ...patch }))
  const key = (await $.env.get('TYPESAFE_API_KEY')) ?? (await $.env.get('JEV_API_KEY'))
  if (key === undefined || key === '') {
    await finish({ status: 'unavailable', reason: 'TYPESAFE_API_KEY is not set' })

    return
  }

  try {
    const { value } = await $.state.get(ledgerRef)
    const l = value ?? EMPTY
    const past: Past[] = l.rows
      .filter(r => r.id !== rowId && r.status !== 'running')
      .slice(-5)
      .map(r => ({
        task: r.label,
        model: actualModel(r) ?? 'unknown',
        result: r.status,
        costUsd: rowCost(r).isEmpty ? null : rowCost(r).usd,
      }))
    const body = buildRequest({
      task: cut(task, 2000),
      current: current || 'unknown',
      spentUsd: spentUsd(l),
      past,
    })
    const started = await $.clock.now()
    const res = await $.http.fetch(JEV_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    })
    const ms = (await $.clock.now()) - started
    if (!res.ok) {
      await finish({ status: 'error', reason: `Jev answered HTTP ${res.status}`, ms })

      return
    }
    const advice = parseAdvice(JSON.parse(res.text))
    if (advice === null) {
      await finish({ status: 'error', reason: 'Jev reply had an unexpected shape', ms })

      return
    }
    await finish({
      status: 'ok',
      recommended: advice.recommended,
      confidence: advice.confidence,
      probabilities: advice.probabilities,
      taskComplexity: advice.taskComplexity,
      reasoningRequired: advice.reasoningRequired,
      jevInputTokens: advice.inputTokens,
      jevOutputTokens: advice.outputTokens,
      ms,
    })
  } catch {
    await finish({ status: 'error', reason: 'The Jev call failed' })
  }
}

async function refreshAgents($: Engine): Promise<void> {
  const list = await $.agent.list()
  const now = await $.clock.now()
  const { value } = await $.state.get(ledgerRef)
  const cur = value ?? EMPTY
  const next = mergeAgents(cur, list, now)
  const isLive = next.rows.some(r => r.kind === 'agent' && r.status === 'running')
  if (!isLive && JSON.stringify(next.rows) === JSON.stringify(cur.rows)) return
  await update($, ledger, l => ({ ...mergeAgents(l, list, now), now: isLive ? now : l.now }))
}

const describeCall = (e: { tool: string }): string => {
  const input = e as unknown as Record<string, unknown>
  const target = [input.file_path, input.command, input.pattern, input.url, input.description].find(
    v => typeof v === 'string',
  )

  return target === undefined ? e.tool : `${e.tool} ${cut(oneLine(String(target)), 50)}`
}

export const register: Register = on => {
  let poll: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'run-ledger', description: 'Open the Run Ledger pane' })
    await $.command.register({ name: 'run-ledger-report', description: 'Print the Run Ledger as text' })
    if ((await $.session.surfaces()).length > 0) void $.ui.open({ id: PANE, title: 'Run Ledger' })
    poll?.cancel()
    poll = $.clock.every(2000, () => void refreshAgents($))

    return next(e)
  })

  on('command.run', { command: 'run-ledger' }, async $ => {
    // With no surface attached a pane has nowhere to draw: print the report instead.
    if ((await $.session.surfaces()).length === 0) {
      const { value } = await $.state.get(ledgerRef)

      return { text: `No screen is attached to this session, so no pane is opened.\n\n${renderReport(value ?? EMPTY)}` }
    }
    const opened = await $.ui.open({ id: PANE, title: 'Run Ledger' })
    const { value } = await $.state.get({ plugin: 'run-ledger', key: 'view' } as const)
    const log = value?.log ?? []
    const trail = log.length === 0 ? 'no surface or pane events seen yet' : log.join('; ')

    return {
      text: `${
        opened.isPlaced
          ? 'Run Ledger opened.'
          : `Run Ledger is open but this surface did not draw it: ${opened.reason}.`
      } Events: ${trail}`,
    }
  })

  on('command.run', { command: 'run-ledger-report' }, async $ => {
    const { value } = await $.state.get(ledgerRef)

    return { text: renderReport(value ?? EMPTY) }
  })

  on('session.attach', async ($, e, next) => {
    await note($, `attach ${e.surface} ${e.viewport?.columns ?? '?'}x${e.viewport?.rows ?? '?'}`)

    return next(e)
  })

  on('session.detach', async ($, e, next) => {
    await note($, `detach ${e.surface} (${e.reason})`)

    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await note($, `pane closed by ${e.origin.kind}`)

    return next(e)
  })

  // A fallback for surfaces that seat no panes: one line above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const l: Ledger = await read($, ledger)
    if (e.props.hasSurvey || l.rows.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const total = totalCost(l)
    const runs = l.rows.filter(r => r.kind === 'run').length
    const agents = l.rows.filter(r => r.kind === 'agent').length
    const known = l.rows.some(r => !rowCost(r).isEmpty)

    return (
      <Box>
        <Text dimColor>
          {`Run Ledger · ${known ? fmtCost(total.usd, total.hasUnknown) : 'cost unknown'} (API estimate) · ${runs} runs · ${agents} subagents`}
        </Text>
      </Box>
    )
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text.trim() !== '') {
      const at = await $.clock.now()
      const label = cut(oneLine(e.text), 60)
      await update($, ledger, l =>
        upsertRow(l, {
          id: e.turnId,
          kind: 'run',
          label,
          source: 'you',
          status: 'running',
          startedAt: at,
          latestAction: '',
          requests: 0,
          noUsage: 0,
          byModel: {},
        }),
      )
      $.clock.after(0, () => void recommend($, e.turnId, label, e.text, ''))
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    try {
      const at = await $.clock.now()
      await update($, ledger, l =>
        recordStep(l, {
          key: `${e.turnId}:${e.index}`,
          rowId: e.agentId ?? e.turnId,
          isAgent: e.agentId !== undefined,
          requestModel: e.model,
          usage: result.usage,
          at,
        }),
      )
    } catch {
      // A ledger failure must never disturb the response.
    }

    return result
  })

  on('tool.call', async ($, e, next) => {
    const action = describeCall(e)
    try {
      await update($, ledger, l => {
        const id = e.agentId ?? lastRunning(l)?.id

        return id === undefined ? l : patchRow(l, id, { latestAction: action })
      })
    } catch {
      // Display only.
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const at = await $.clock.now()
    if (e.agentId === undefined) {
      await update($, ledger, l => patchRow(l, e.turnId, { status: RUN_STATUS[e.reason] ?? 'done', endedAt: at }))
    } else {
      void refreshAgents($)
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const agentId = r.agentId
    if (r.deny === undefined && agentId !== undefined) {
      const at = await $.clock.now()
      const label = cut(oneLine(e.description || e.prompt), 60)
      const model = r.model
      await update($, ledger, l =>
        upsertRow(l, {
          id: agentId,
          kind: 'agent',
          label,
          source: e.provider.plugin === 'engine' ? 'model or you' : e.provider.plugin,
          type: e.subagentType,
          model,
          runId: lastRunning(l)?.id,
          status: 'running',
          startedAt: at,
          latestAction: 'starting',
          requests: 0,
          noUsage: 0,
          byModel: {},
        }),
      )
      $.clock.after(0, () => void recommend($, agentId, label, e.prompt, model))
    }

    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    try {
      return await (async () => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const l: Ledger = await read($, ledger)
    const v: View = await read($, view)
    const cols = Math.max(30, e.props.bodyColumns ?? 60)
    const total = totalCost(l)
    const go = (tab: View['tab']) => update($, view, () => ({ tab, detail: null }))
    const open = (detail: string) => update($, view, x => ({ ...x, detail }))
    const rows = l.rows.filter(r => (v.tab === 'agents' ? r.kind === 'agent' : r.kind === 'run')).slice().reverse()
    const room = Math.max(3, Math.floor(((e.viewport?.rows ?? 30) - 9) / 2))
    const now = l.now
    const elapsed = (r: Row) => fmtElapsed((r.endedAt ?? Math.max(now, r.startedAt)) - r.startedAt)
    const costText = (r: Row) => {
      const c = rowCost(r)

      return c.isEmpty ? 'unknown' : fmtCost(c.usd, c.hasUnknown)
    }
    const jevIn = l.recs.reduce((n, r) => n + r.jevInputTokens, 0)
    const jevOut = l.recs.reduce((n, r) => n + r.jevOutputTokens, 0)
    const jevCalls = l.recs.filter(r => r.status === 'ok').length
    const recOf = (r: Row) => l.recs.find(x => x.rowId === r.id)
    const picked = v.detail === null ? undefined : l.rows.find(r => r.id === v.detail)

    const header = (
      <Box flexDirection="column">
        <Text bold>Run Ledger</Text>
        <Text dimColor>
          {cut(`API estimates, not subscription charges. Prices as of ${PRICES_AS_OF}.`, cols)}
        </Text>
        <Text>
          {`Session ${total.usd === 0 && l.rows.every(r => rowCost(r).isEmpty) ? 'unknown' : fmtCost(total.usd, total.hasUnknown)} · Jev ${jevCalls} calls, ${fmtTokens(jevIn)} in / ${fmtTokens(jevOut)} out tokens, cost unknown`}
        </Text>
        <Box>
          <Button key="tab-runs" label="Runs" variant={v.tab === 'runs' ? 'primary' : 'secondary'} onPress={() => go('runs')} />
          <Button key="tab-agents" label="Subagents" variant={v.tab === 'agents' ? 'primary' : 'secondary'} onPress={() => go('agents')} />
          <Button key="tab-advice" label="Advice" variant={v.tab === 'advice' ? 'primary' : 'secondary'} onPress={() => go('advice')} />
        </Box>
      </Box>
    )

    const footer = (
      <Box flexDirection="column">
        <Text dimColor>{cut(ASSUMPTIONS, cols * 2)}</Text>
        <Button
          key="export"
          label="Export JSON"
          onPress={async () => {
            const path = `${$.plugin.root}/export-${await $.clock.now()}.json`
            const { value } = await $.state.get(ledgerRef)
            await $.fs.write(path, JSON.stringify(value ?? EMPTY, null, 2))
            $.ui.toast(`Exported to ${path}`)
          }}
        />
      </Box>
    )

    if (picked !== undefined) {
      const rec = recOf(picked)

      return (
        <Box flexDirection="column">
          {header}
          <Button key="back" label="Back" onPress={() => update($, view, x => ({ ...x, detail: null }))} />
          <Text bold>{cut(`${mark(picked.status)} ${picked.label}`, cols)}</Text>
          <Text dimColor>
            {cut(`${picked.kind === 'agent' ? `subagent ${picked.type ?? ''}` : 'run'} · ${picked.status} · ${elapsed(picked)} · source ${picked.source}`, cols * 2)}
          </Text>
          <Text dimColor>{cut(`Latest: ${picked.latestAction || 'none yet'}`, cols * 2)}</Text>
          <Text>
            {`Requests ${picked.requests} counted once · ${picked.noUsage} ended with no usage · retries not reported`}
          </Text>
          {Object.entries(picked.byModel).length === 0 && <Text dimColor>No usage recorded yet.</Text>}
          {Object.entries(picked.byModel).map(([model, m]) => (
            <Text>
              {cut(`${model}: ${m.requests} req · in ${fmtTokens(m.input)} · out ${fmtTokens(m.output)} · cache read ${fmtTokens(m.cacheRead)} · cache write ${fmtTokens(m.cacheWrite)} · ${fmtCost(m.costUsd)}`, cols * 3)}
            </Text>
          ))}
          {rec !== undefined && (
            <Text>
              {cut(
                rec.status === 'ok'
                  ? `Jev advised ${rec.recommended} (${Math.round((rec.confidence ?? 0) * 100)}% confident); ran on ${actualModel(picked) ?? 'unknown'}`
                  : `Jev advice ${rec.status}${rec.reason === undefined ? '' : `: ${rec.reason}`}`,
                cols * 3,
              )}
            </Text>
          )}
          {footer}
        </Box>
      )
    }

    if (v.tab === 'advice') {
      const recs = l.recs.slice().reverse().slice(0, room)

      return (
        <Box flexDirection="column">
          {header}
          {recs.length === 0 && <Text dimColor>No advice yet. Advice only: nothing is routed.</Text>}
          {recs.map(rec => {
            const row = l.rows.find(r => r.id === rec.rowId)
            const actual = row === undefined ? undefined : actualModel(row)
            const verdict =
              rec.status !== 'ok' ? rec.status : actual === undefined ? 'pending' : actual === rec.recommended ? 'matched' : 'differed'

            return (
              <Box flexDirection="column">
                <Text>{cut(`${rec.label}`, cols)}</Text>
                <Text dimColor>
                  {cut(
                    rec.status === 'ok'
                      ? `advised ${rec.recommended} (${Math.round((rec.confidence ?? 0) * 100)}%) · ran ${actual ?? 'unknown'} · ${verdict} · result ${row?.status ?? 'unknown'} · cost ${row === undefined ? 'unknown' : costText(row)}`
                      : `${rec.status}${rec.reason === undefined ? '' : `: ${rec.reason}`}`,
                    cols * 3,
                  )}
                </Text>
              </Box>
            )
          })}
          {footer}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {rows.length === 0 && <Text dimColor>{v.tab === 'agents' ? 'No subagents yet.' : 'No runs yet.'}</Text>}
        {rows.slice(0, room).map(r => (
          <Button key={r.id} plain onPress={() => open(r.id)}>
            {cut(`${mark(r.status)} ${r.label}`, cols)}{' '}
            <Text dimColor>
              {cut(
                v.tab === 'agents'
                  ? `${r.status} · ${actualModel(r) ?? 'unknown'} · ${costText(r)} · ${elapsed(r)} · ${cut(r.latestAction || 'no action yet', 40)}`
                  : `${actualModel(r) ?? 'unknown'} · ${costText(r)} · ${r.requests} req · ${elapsed(r)}`,
                cols * 3,
              )}
            </Text>
          </Button>
        ))}
        {footer}
      </Box>
    )
      })()
    } catch (err) {
      // A drawing that throws makes the engine drop the pane; show the cause instead.
      const { Text } = $.ui.resolve(e)

      return <Text>{`Run Ledger could not draw: ${err instanceof Error ? err.message : String(err)}`}</Text>
    }
  })
}
