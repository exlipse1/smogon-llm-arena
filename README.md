# Smogon LLM Arena

LLM benchmark for **6v6 Smogon singles** in frozen **[Gen 9 Champions] OU**.

The benchmark pins Pokemon Showdown to commit
`8d3a9807d08f9a49845dd8d568e6bb0da08c978d`, observed on June 16, 2026, and
checks that the local simulator still exposes:

- format: `[Gen 9 Champions] OU`
- format id: `gen9championsou`
- mod: `champions`
- ruleset: `Standard`
- banlist: `AG`, `Uber`, `Moody`, `Quick Claw`, `Baton Pass`, `Last Respects`, `Shed Tail`

## Benchmark Tracks

**Builder Track**

Models generate Showdown importable teams. The benchmark validates those teams
against the frozen format and can score them by piloting all submitted teams
with the same fixed agent, such as `heuristic`.

**Pilot Track**

Models pilot fixed teams. This isolates battle play: sequencing, switching,
prediction, risk management, and endgame conversion.

**Champion Track**

Models build and pilot their own teams in a round-robin or ladder-style Elo
evaluation. This is the headline "how good is this LLM at Champions OU?" score.

The current scaffold implements the full Showdown-backed battle runner, team
builder call, local baselines, round-robin Elo tournament runner, persistent
ladder runner, and static leaderboard website.

## Setup

With pnpm available:

```bash
pnpm install
pnpm run build:showdown
pnpm run smoke
```

In this Codex desktop environment, the bundled runtime can be used directly:

```bash
export PATH="/Users/adamschauer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"

/Users/adamschauer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  /Users/adamschauer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.cjs install

/Users/adamschauer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  scripts/build-showdown.mjs

/Users/adamschauer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  test/smoke.mjs
```

## Commands

Verify the frozen format:

```bash
node src/cli.js freeze-check
```

Validate teams:

```bash
node src/cli.js validate-team data/teams/baseline.txt
```

Run a local battle:

```bash
node src/cli.js match --agent-a random --agent-b heuristic --games 2
```

Run a round-robin Elo tournament:

```bash
node src/cli.js tournament \
  --manifest config/benchmark.smoke.json \
  --out results/smoke.json
```

Run a persistent ladder slice and publish the website data:

```bash
node src/cli.js ladder \
  --manifest config/ladder.smoke.json \
  --games 4 \
  --state results/ladder-smoke/state.json \
  --matches results/ladder-smoke/matches.jsonl \
  --site site/leaderboard.json
```

Serve the dashboard:

```bash
pnpm run serve:site
```

Open `http://localhost:4173`.

Ask GPT-5.5 to build a team:

```bash
OPENAI_API_KEY=... node src/cli.js build-team \
  --model gpt-5.5 \
  --out data/teams/gpt-5.5.txt
```

Or put the key in `.env`:

```bash
cp .env.example .env
```

Then run the one-command GPT-5.5 path:

```bash
pnpm run gpt55
```

Then evaluate GPT-5.5 in the Champion Track by creating a manifest entry:

```json
{
  "id": "gpt-5.5",
  "type": "openai",
  "model": "gpt-5.5",
  "teamFile": "data/teams/gpt-5.5.txt"
}
```

## Continuous Model Ladder

`config/ladder.openai.example.json` starts the requested OpenAI roster:

- `o3`
- `gpt-5.2`
- `gpt-5.4`
- `gpt-5.5`

Each entry has an OpenAI model id, a Showdown team file, and Pokemon Showdown
account environment variables. The initial roster uses a fixed shared pilot team
so early public-ladder results isolate battle piloting. Replace those team files
or run `node scripts/build-openai-roster-teams.mjs --force` for builder/champion
seasons.

The runner writes three durable artifacts:

- `results/ladder/state.json`: current Elo, health counters, streaks, and rating history
- `results/ladder/matches.jsonl`: append-only battle log for analysis
- `site/leaderboard.json`: static website payload

Use `--continuous --interval-ms 30000` to keep scheduling battles in the current
local shadow ladder. The account fields are already present so the same manifest
can back the live Pokemon Showdown account daemon once credentials and account
policy are settled.

For public Pokemon Showdown accounts, start one live bot process per model:

```bash
node src/cli.js live-ladder \
  --manifest config/ladder.openai.example.json \
  --player gpt-5.5 \
  --games 1
```

The live client logs in with the player entry's `showdownAccount` environment
variables, sends `/utm`, searches `gen9championsou`, and answers battle
`|request|` messages with the same agent interface as local battles. See
`docs/live-showdown-ladder.md`.

Publish the website from live account logs:

```bash
node src/cli.js publish-live \
  --manifest config/ladder.openai.example.json \
  --matches-dir results/live-ladder \
  --site site/leaderboard.json \
  --poll-ratings
```

Run the whole configured account roster:

```bash
node scripts/activate-live-benchmark.mjs \
  --manifest config/ladder.openai.example.json \
  --site site/leaderboard.json \
  --start \
  --continuous
```

Audit live readiness:

```bash
node scripts/activate-live-benchmark.mjs \
  --manifest config/ladder.openai.example.json \
  --matches-dir results/live-ladder \
  --site site/leaderboard.json
```

The activation preflight reports missing `OPENAI_API_KEY` and Pokemon Showdown
account variables before any live connections are made. Add `--start` only when
the report says `ready-to-start`.

Verify the whole local bundle:

```bash
node scripts/verify-benchmark.mjs
```

Smoke-test the live Showdown protocol loop without real credentials:

```bash
node test/live-ladder-mock.mjs
```

Check the static dashboard payload:

```bash
node scripts/check-site.mjs
```

Deployment notes live in `docs/deployment.md`; `netlify.toml` and GitHub Pages
workflows are included for static hosts that serve the generated `site/`
directory.

Activation inputs and launch commands are collected in
`docs/activation-checklist.md`.

## Agent Interface

Battle agents receive:

- frozen format name/id
- side id
- current turn
- legal choice strings, for example `move 1`, `switch 4`, `team 123456`
- sanitized active request data
- recent public battle log

Agents return one choice string. The runner validates the choice before sending
it to Showdown. Invalid choices, Showdown choice errors, timeouts, and API errors
are counted in the game result.

## Outputs

Tournament output includes:

- final Elo ratings
- game-by-game winners
- turns
- invalid action counts
- timeout counts
- frozen Showdown commit and format metadata

Ladder website output also includes:

- per-model Showdown account readiness
- benchmark health: active, waiting, and stale model counts
- win/loss/tie record
- peak and floor Elo
- average battle length
- invalid action, timeout, and model error counters
- recent match log and rating history

The default Elo settings are in `config/freeze.json`.
