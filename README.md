# Run Ledger

A Claude Code mod that keeps a ledger of your runs and subagents: which model answered, token counts (input, output, cache reads and writes), and an estimated cost for each. It can also ask TypeSafe's Jev which model it would recommend for each task, and shows that next to the model that actually ran. It is advice only: nothing is routed or changed.

## Install

In a terminal session:

```
/plugin install run-ledger --marketplace islandhopper81/run-legger
```

From a shell:

```
claude plugin install run-ledger --marketplace islandhopper81/run-legger
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `islandhopper81/run-legger`, then Add plugin.

To turn it off: `claude plugin disable run-ledger` (and `claude plugin enable run-ledger` to bring it back).

## Use

- `/run-ledger` opens the dashboard pane. Where no screen is attached (for example a cloud session) it prints the report as text instead.
- `/run-ledger-report` always prints the ledger as text.

## Notes

- Costs are API estimates at dated prices (see `hooks/cost.ts`), not subscription charges. A model with no listed price shows `unknown`. Cache writes (1.25x input) and some cache reads (0.1x input) are assumptions.
- The API does not report retries, so the ledger says so instead of guessing.
- Jev advice needs `TYPESAFE_API_KEY` (or `JEV_API_KEY`) in the environment. When it is set, the task text of each prompt and subagent is sent to TypeSafe. Without a key nothing is sent anywhere.
- The mod never makes model calls for its dashboard and never changes a request.
