# Deployment

The benchmark runtime and the public website are deliberately separated:

- live bot processes write `results/live-ladder/<player>.jsonl`
- `publish-live` turns those logs into `site/leaderboard.json`
- season snapshots are archived under `site/seasons/<season-id>/leaderboard.json`
  when `manifest.season.archiveDir` or `--archive-dir` is set
- any static host can serve the `site/` directory
- the published payload includes a `health` block used by the dashboard status
  band to show active/waiting/stale models

Before launching live accounts, collect the credentials, account policy, and
hosting choices in `docs/activation-checklist.md`.

## One-Machine Service

Build or validate teams first:

```bash
node scripts/build-openai-roster-teams.mjs \
  --manifest config/ladder.openai.example.json
```

Check readiness without starting bots:

```bash
node src/cli.js doctor \
  --manifest config/ladder.openai.example.json \
  --matches-dir results/live-ladder \
  --site site/leaderboard.json \
  --poll-ratings
```

Preview which bot processes would run:

```bash
node scripts/run-live-roster.mjs \
  --manifest config/ladder.openai.example.json \
  --dry-run
```

Run every ready account continuously and republish the site payload every
30 seconds:

```bash
node scripts/activate-live-benchmark.mjs \
  --manifest config/ladder.openai.example.json \
  --matches-dir results/live-ladder \
  --site site/leaderboard.json \
  --start \
  --publish-interval-ms 30000
```

Serve locally:

```bash
node scripts/serve-site.mjs site 4173
```

## Docker Compose

The repository includes a `Dockerfile` and `docker-compose.yml` with two
services:

- `arena-runner`: starts every ready model account, writes JSONL logs, and
  republishes `site/leaderboard.json`, and archives season payloads when
  configured
- `arena-site`: serves the static dashboard on port `4173`

Before starting, create `.env` with OpenAI and Pokemon Showdown credentials and
make sure each configured team file exists under `data/teams/`.

```bash
docker compose build
docker compose run --rm arena-runner node src/cli.js doctor \
  --manifest config/ladder.openai.example.json \
  --matches-dir results/live-ladder \
  --site site/leaderboard.json \
  --poll-ratings
docker compose up -d
```

The compose file bind-mounts `data/teams/`, `results/`, and `site/` so battle
logs and the public dashboard payload persist outside the container.

## External Static Website

Upload the entire `site/` directory to any static host after every publish. Good
fits are GitHub Pages, Netlify, Cloudflare Pages, Vercel static output, or an S3
bucket with static website hosting.

Check the static payload before publishing:

```bash
node scripts/check-site.mjs
```

This repository also includes two GitHub Actions workflows under
`.github/workflows/`:

- `verify.yml` runs `pnpm run verify` on pushes and pull requests.
- `pages.yml` publishes the `site/` directory to GitHub Pages when dashboard
  files change on `main`, or when manually dispatched.

Those workflows assume `smogon-llm-arena` is the repository root. If this
project stays inside a larger monorepo, copy the workflow files to the monorepo
root and set each command's `working-directory` to `smogon-llm-arena`.

For a minimal server sync loop:

```bash
node src/cli.js publish-live \
  --manifest config/ladder.openai.example.json \
  --matches-dir results/live-ladder \
  --site site/leaderboard.json \
  --poll-ratings \
  --archive-dir site/seasons

rsync -av --delete site/ user@host:/var/www/smogon-llm-arena/
```

The static host should send `Cache-Control: no-store` or a short TTL for
`leaderboard.json`; the HTML/CSS/JS can be cached longer.

## Secrets

Do not commit `.env` or Showdown passwords. The roster manifest references
environment variable names only:

```text
PS_O3_USERNAME=...
PS_O3_PASSWORD=...
PS_GPT_52_USERNAME=...
PS_GPT_52_PASSWORD=...
PS_GPT_54_USERNAME=...
PS_GPT_54_PASSWORD=...
PS_GPT_55_USERNAME=...
PS_GPT_55_PASSWORD=...
```

`OPENAI_API_KEY` is required for OpenAI model play and team generation.

## Production Notes

- Run one supervised process per account, or use `run-live-roster.mjs` under a
  process manager such as systemd, pm2, or Docker Compose.
- Run `node scripts/verify-benchmark.mjs` before deploying a build. It performs
  syntax checks, smoke battles, offline live-ladder protocol simulation,
  live-result publishing, readiness audit, and dry-runs for roster/team
  operations.
- Keep raw JSONL logs; they are the audit trail for published stats.
- Preserve `config/freeze.json` with every published leaderboard so the public
  site can identify the exact format and Showdown commit.
- Set `manifest.season.id` before each reset. Keep the matching
  `site/seasons/<season-id>/leaderboard.json` archive when publishing the next
  season.
- Watch `site/leaderboard.json.health.state`; `active` means every model has a
  recent battle, `degraded` means at least one model is stale or waiting.
- Expect public ladder scores to be noisier than the local shadow ladder because
  opponents, time of day, and ladder population change.
