import type { Tokens } from '../types'

/** When the table below was read from the published API prices. */
export const PRICES_AS_OF = '2026-10-06'

export const ASSUMPTIONS =
  'Cache writes are priced at 1.25x input and cache reads at 0.1x input unless a rate is listed; both are assumptions.'

type Price = {
  match: RegExp
  /** Dollars per million tokens. */
  input: number
  output: number
  cacheRead?: number
  /** Beyond this prompt size the long-prompt rates apply. */
  longPromptOver?: number
  longInput?: number
  longOutput?: number
}

// Most specific first: the first match wins. Prices are the first-party API
// rates per million tokens; edit them and PRICES_AS_OF together.
const PRICES: Price[] = [
  { match: /fable-5/, input: 10, output: 50, cacheRead: 0.25 },
  { match: /opus-5-5/, input: 4, output: 20, cacheRead: 0.2 },
  { match: /opus-(5|4-[678])/, input: 5, output: 25 },
  { match: /sonnet-5/, input: 2, output: 10, cacheRead: 0.2 },
  { match: /sonnet-4/, input: 3, output: 15 },
  {
    match: /haiku-5/,
    input: 0.1,
    output: 0.5,
    longPromptOver: 100_000,
    longInput: 0.5,
    longOutput: 2.5,
  },
  { match: /haiku-4/, input: 1, output: 5 },
]

export const priceOf = (model: string): Price | undefined =>
  PRICES.find(p => p.match.test(model))

export const NO_TOKENS: Tokens = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

export const addTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

/** Dollars for one request's tokens, or null when the model has no price. */
export function costOf(model: string, t: Tokens): number | null {
  const p = priceOf(model)
  if (p === undefined) return null
  const prompt = t.input + t.cacheRead + t.cacheWrite
  const isLong = p.longPromptOver !== undefined && prompt > p.longPromptOver
  const input = isLong ? (p.longInput ?? p.input) : p.input
  const output = isLong ? (p.longOutput ?? p.output) : p.output
  const cacheRead = p.cacheRead ?? input * 0.1
  const cacheWrite = input * 1.25

  return (
    (t.input * input +
      t.output * output +
      t.cacheRead * cacheRead +
      t.cacheWrite * cacheWrite) /
    1_000_000
  )
}

/** Dollars, with unknown where a price is missing. */
export function fmtCost(usd: number | null, hasUnknown = false): string {
  if (usd === null) return 'unknown'
  const text = usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`

  return hasUnknown ? `${text}+unknown` : text
}

export const fmtTokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n)

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))

  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
