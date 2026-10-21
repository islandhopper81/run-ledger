import type { Ledger, Row } from '../types'
import { ASSUMPTIONS, PRICES_AS_OF, fmtCost, fmtElapsed, fmtTokens } from './cost'
import { actualModel, rowCost, totalCost } from './ledger'

const costText = (r: Row): string => {
  const c = rowCost(r)

  return c.isEmpty ? 'unknown' : fmtCost(c.usd, c.hasUnknown)
}

const line = (r: Row, now: number): string =>
  `- ${r.status} | ${r.label} | ${actualModel(r) ?? 'unknown'} | ${costText(r)} | ${r.requests} req` +
  `${r.noUsage > 0 ? ` (+${r.noUsage} with no usage)` : ''} | ${fmtElapsed((r.endedAt ?? Math.max(now, r.startedAt)) - r.startedAt)}` +
  `${r.kind === 'agent' ? ` | ${r.source} | ${r.latestAction || 'no action yet'}` : ''}`

/** The ledger as plain text, for a surface that draws nothing. */
export function renderReport(l: Ledger): string {
  const runs = l.rows.filter(r => r.kind === 'run').slice(-10).reverse()
  const agents = l.rows.filter(r => r.kind === 'agent').slice(-10).reverse()
  const total = totalCost(l)
  const known = l.rows.some(r => !rowCost(r).isEmpty)
  const out: string[] = [
    `Run Ledger: API estimates, not subscription charges. Prices as of ${PRICES_AS_OF}.`,
    `Session cost: ${known ? fmtCost(total.usd, total.hasUnknown) : 'unknown'} over ${l.rows.length} runs and subagents.`,
  ]

  out.push('', 'Runs (status | task | model | cost | requests | elapsed)')
  out.push(...(runs.length === 0 ? ['- none recorded yet'] : runs.map(r => line(r, l.now))))
  out.push('', 'Subagents (status | task | model | cost | requests | elapsed | source | latest action)')
  out.push(...(agents.length === 0 ? ['- none recorded yet'] : agents.map(r => line(r, l.now))))

  out.push('', 'Jev advice (recommended vs actual; advice only, nothing is routed)')
  const recs = l.recs.slice(-10).reverse()
  if (recs.length === 0) out.push('- none yet')
  for (const rec of recs) {
    const row = l.rows.find(r => r.id === rec.rowId)
    const actual = row === undefined ? undefined : actualModel(row)
    out.push(
      rec.status === 'ok'
        ? `- ${rec.label}: advised ${rec.recommended} (${Math.round((rec.confidence ?? 0) * 100)}% confident), ran ${actual ?? 'unknown'}, ${actual === rec.recommended ? 'matched' : 'differed'}, result ${row?.status ?? 'unknown'}, cost ${row === undefined ? 'unknown' : costText(row)}`
        : `- ${rec.label}: ${rec.status}${rec.reason === undefined ? '' : ` (${rec.reason})`}`,
    )
  }
  const jevIn = l.recs.reduce((n, r) => n + r.jevInputTokens, 0)
  const jevOut = l.recs.reduce((n, r) => n + r.jevOutputTokens, 0)
  out.push(
    `Jev's own use: ${l.recs.filter(r => r.status === 'ok').length} calls, ${fmtTokens(jevIn)} in / ${fmtTokens(jevOut)} out tokens, cost unknown (no Jev price on file).`,
    'Retries are not reported by the API.',
    ASSUMPTIONS,
  )

  return out.join('\n')
}
