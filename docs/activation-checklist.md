# Activation Checklist

Use this checklist when moving the benchmark from local verification to live
Pokemon Showdown laddering with a public website.

## Information Needed From The Operator

Required:

- An `OPENAI_API_KEY` with access to the configured models: `o3`, `gpt-5.2`,
  `gpt-5.4`, and `gpt-5.5`. If those are not the exact API model ids available
  in the account, provide the replacement ids before launching.
- One Pokemon Showdown account per model. Put the credentials in `.env` or the
  deployment secret store using these names:

```text
PS_O3_USERNAME=
PS_O3_PASSWORD=
PS_GPT_52_USERNAME=
PS_GPT_52_PASSWORD=
PS_GPT_54_USERNAME=
PS_GPT_54_PASSWORD=
PS_GPT_55_USERNAME=
PS_GPT_55_PASSWORD=
```

- Confirmation that automated laddering with these accounts is allowed under
  the benchmark policy and any server/account rules you want followed.
- Live-run policy: continuous or bounded runs, maximum simultaneous accounts,
  publish interval, and any stop condition such as games per model or daily API
  budget.
- Static website target: GitHub Pages repository, Netlify site, static server,
  S3 bucket, or another host, plus the intended public URL/domain if known.
- Team policy for the first season: keep the fixed shared pilot teams currently
  in `data/teams/`, or replace them with model-built teams before launch.

Optional but useful:

- External dashboard URL for `doctor --external-url`.
- Season label, reset cadence, and whether to archive old JSONL logs by season.
- Battle choice timeout and OpenAI rate/budget limits.

Do not commit API keys or Pokemon Showdown passwords. Prefer writing them to the
local `.env` file, Docker/host secrets, or the CI/CD secret store instead of
posting them in chat.

## Local Activation Steps

Create the local environment file:

```bash
cp .env.example .env
```

Fill in `OPENAI_API_KEY` and the Pokemon Showdown account variables. Then audit
readiness:

```bash
node scripts/activate-live-benchmark.mjs \
  --manifest config/ladder.openai.example.json \
  --matches-dir results/live-ladder \
  --site site/leaderboard.json
```

The activation script is a preflight by default. It prints the missing inputs,
per-player readiness, and the exact live-roster command it will run. Missing
credentials are expected before activation. To make preflight failures exit
non-zero in automation, add `--strict`.

For the full diagnostic report, run:

```bash
node src/cli.js doctor \
  --manifest config/ladder.openai.example.json \
  --matches-dir results/live-ladder \
  --site site/leaderboard.json \
  --poll-ratings
```

If the season should use model-built teams instead of the fixed shared pilot
teams, regenerate the roster teams after credentials are present:

```bash
node scripts/build-openai-roster-teams.mjs \
  --manifest config/ladder.openai.example.json \
  --force
```

Preview the account processes without connecting:

```bash
node scripts/run-live-roster.mjs \
  --manifest config/ladder.openai.example.json \
  --dry-run
```

Start the live account roster and keep the static payload fresh:

```bash
node scripts/activate-live-benchmark.mjs \
  --manifest config/ladder.openai.example.json \
  --matches-dir results/live-ladder \
  --site site/leaderboard.json \
  --start \
  --publish-interval-ms 30000
```

For a bounded launch instead of continuous laddering, add `--games N`. The
script will pass `--continuous false` to the live roster runner.

The example manifest archives each published season payload to
`site/seasons/champion-2026-06-16/leaderboard.json`. Before a new season, update
`manifest.season.id`, `name`, and `startedAt`, then keep the old
`site/seasons/` directory when syncing the static site.

Check Pokemon Showdown account logins without starting ladder games:

```bash
node scripts/check-showdown-logins.mjs \
  --manifest config/ladder.openai.example.json
```

If the team builder returns `insufficient_quota`, enable billing or raise quota
for the OpenAI project that owns `OPENAI_API_KEY`, then rerun:

```bash
node scripts/build-openai-roster-teams.mjs \
  --manifest config/ladder.openai.example.json \
  --force
```

Serve the local dashboard preview:

```bash
node scripts/serve-site.mjs site 4173
```

Publish `site/` to the selected static host after `site/leaderboard.json` is
generated and validated:

```bash
node scripts/check-site.mjs
```
