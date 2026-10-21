import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'run-ledger',
  component: 'Pane',
  requestId: 'run-ledger',
  props: {
    title: 'Run Ledger',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const stepResult = (index: number) => ({
  turnId: 't1',
  index,
  answer: '',
  toolUses: [],
  stopReason: 'end_turn' as const,
  usage: {
    model: 'claude-sonnet-5-5',
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
})

test('events fill the ledger once each and the pane shows it on every surface', async ($, on) => {
  on('command.register', () => ({ value: { command: 'run-ledger' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1000 }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', () => ({ value: undefined }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    return stepResult(e.index)
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'fix the failing test', turnId: 't1' })
  const input = { turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 }
  for (const i of [input, input, { ...input, index: 1 }]) {
    const stream = $.turn.step(i)
    for await (const _chunk of stream) {
      // The stream carries no chunks here; the result is what counts.
    }
  }

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /API estimates, not subscription charges/ })).toBeDefined()
    // Two distinct requests at $2/$10 per million: 2 x (1000 x 2 + 500 x 10) / 1e6.
    expect(await ui.find({ type: 'Text', text: /Session \$0\.01 / })).toBeDefined()

    await ui.press({ key: 'tab-advice' })
    expect(await ui.find({ type: 'Text', text: /unavailable: TYPESAFE_API_KEY is not set/ })).toBeDefined()
    await ui.press({ key: 'tab-runs' })

    await ui.press({ key: 't1' })
    expect(await ui.find({ type: 'Text', text: /claude-sonnet-5-5: 2 req/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /retries not reported/ })).toBeDefined()
    await ui.unmount()
  }
})
