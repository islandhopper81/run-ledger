import { priceOf } from './cost'

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = 'jev-latest'

/** The models Jev may recommend between, cheapest first. */
export const CANDIDATES = [
  { id: 'claude-haiku-5-5', tier: 'haiku', name: 'Claude Haiku 5.5' },
  { id: 'claude-sonnet-5-5', tier: 'sonnet', name: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', tier: 'opus', name: 'Claude Opus 5.5' },
] as const

/** A per-session spend line given to Jev as context; it never blocks a call. */
export const BUDGET_USD = 5

const SCALE = [
  'None',
  'Very low',
  'Low',
  'Some',
  'Moderate',
  'Moderate to high',
  'High',
  'Very high',
  'Severe',
  'Extreme',
]

const GUIDANCE: Record<string, { what: string; not_for: string }> = {
  haiku: {
    what: 'Trivial, mechanical, or purely factual work.',
    not_for: 'Design judgement or multi-file reasoning.',
  },
  sonnet: {
    what: 'Ordinary engineering with a clear, bounded shape.',
    not_for: 'Open-ended architecture or unknown-cause debugging.',
  },
  opus: {
    what: 'Hard reasoning, ambiguity, or high blast radius.',
    not_for: 'Routine work with a clear implementation.',
  },
}

export type Past = {
  task: string
  model: string
  result: string
  costUsd: number | null
}

export type AskInput = {
  task: string
  current: string
  spentUsd: number
  past: Past[]
}

export type Advice = {
  recommended: string
  confidence: number
  probabilities: Record<string, number>
  taskComplexity: number
  reasoningRequired: number
  inputTokens: number
  outputTokens: number
}

export function buildRequest(input: AskInput) {
  const models = CANDIDATES.map(m => {
    const p = priceOf(m.id)

    return {
      id: m.id,
      name: m.name,
      usd_per_million_input: p?.input ?? null,
      usd_per_million_output: p?.output ?? null,
    }
  })

  return {
    model: JEV_MODEL,
    state: {
      request: input.task,
      session: { current_model: input.current },
      environment: {
        available_models: models,
        budget_usd: { limit: BUDGET_USD, spent_so_far: input.spentUsd },
        past_results: input.past,
      },
    },
    questions: {
      model: {
        type: 'choice',
        instructions: [
          'Pick the cheapest exact model that can fully complete this coding request in one pass, without retrying on a stronger model.',
          'Weigh price and budget against required reasoning. Judge required reasoning, not requested reply length.',
        ],
        criteria: Object.fromEntries(
          CANDIDATES.map(m => [
            m.id,
            { model: m.name, ...GUIDANCE[m.tier] },
          ]),
        ),
      },
      task_complexity: {
        type: 'score',
        instructions:
          'How complex is the coding task overall, including ambiguity, scope, and blast radius?',
        criteria: SCALE,
      },
      reasoning_required: {
        type: 'score',
        instructions:
          'How much reasoning is required to complete the request correctly in one pass?',
        criteria: SCALE,
      },
    },
  }
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

/** Reads Jev's reply; null when it does not have the expected shape. */
export function parseAdvice(body: unknown): Advice | null {
  const r = body as {
    answers?: Record<string, Record<string, unknown>>
    usage?: { input_tokens?: unknown; output_tokens?: unknown }
  } | null
  const model = r?.answers?.model
  if (typeof model?.choice !== 'string') return null

  return {
    recommended: model.choice,
    confidence: num(model.confidence),
    probabilities: (model.probabilities ?? {}) as Record<string, number>,
    taskComplexity: num(r?.answers?.task_complexity?.score) / (SCALE.length - 1),
    reasoningRequired:
      num(r?.answers?.reasoning_required?.score) / (SCALE.length - 1),
    inputTokens: num(r?.usage?.input_tokens),
    outputTokens: num(r?.usage?.output_tokens),
  }
}
