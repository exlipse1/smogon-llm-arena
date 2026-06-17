# Live Pokemon Showdown Ladder

This project has two ladder modes:

- `ladder`: an offline, deterministic shadow ladder that uses the frozen local
  Pokemon Showdown simulator and publishes `site/leaderboard.json`.
- `live-ladder`: an account-backed bot for one configured model account on the
  public Pokemon Showdown WebSocket ladder.

The live client follows the upstream Pokemon Showdown protocol:

- connect to `wss://sim3.psim.us/showdown/websocket`
- respond to `|challstr|...` by requesting a login assertion from
  `https://play.pokemonshowdown.com/api/login`
- finish login with `/trn USERNAME,0,ASSERTION`
- set the team with `/utm PACKED_TEAM`
- search the ladder with `/search FORMAT`
- answer `|request|...` with `/choose CHOICE|RQID`

Run one model account for a bounded smoke battle:

```bash
node src/cli.js live-ladder \
  --manifest config/ladder.openai.example.json \
  --player gpt-5.5 \
  --games 1 \
  --matches results/live-ladder/gpt-5.5.jsonl
```

Run the offline protocol smoke test:

```bash
node test/live-ladder-mock.mjs
```

This test uses an injected WebSocket and login response to verify the live bot's
challstr login, `/trn`, `/utm`, `/search`, battle room parsing, `/choose`, win
handling, and battle-record generation without touching Pokemon Showdown.

Run continuously:

```bash
node src/cli.js live-ladder \
  --manifest config/ladder.openai.example.json \
  --player gpt-5.5 \
  --continuous \
  --matches results/live-ladder/gpt-5.5.jsonl
```

Start one process per model account. The live client appends one JSON record per
completed battle:

```json
{
  "source": "pokemon-showdown-live",
  "playerId": "gpt-5.5",
  "accountUsername": "ArenaGPT55",
  "rated": true,
  "player": {"username": "ArenaGPT55", "ratingBefore": 1512},
  "opponent": {"username": "ladder-user", "ratingBefore": 1498},
  "result": "win",
  "turns": 32
}
```

Publish the public dashboard payload from those logs:

```bash
node src/cli.js publish-live \
  --manifest config/ladder.openai.example.json \
  --matches-dir results/live-ladder \
  --site site/leaderboard.json \
  --poll-ratings
```

With `--poll-ratings`, the publisher refreshes Elo, GXE, and Glicko from the
official Pokemon Showdown user JSON API (`/users/<username>.json`) and falls back
to the latest battle-start rating if the account has no published rating yet.

Audit the whole live setup:

```bash
node src/cli.js doctor \
  --manifest config/ladder.openai.example.json \
  --matches-dir results/live-ladder \
  --site site/leaderboard.json \
  --poll-ratings
```

A production deployment should supervise those model processes, rotate logs,
run `publish-live` after each completed battle or on a short interval, and sync
the `site/` directory to the public host.

Before running live accounts, verify that automated laddering complies with the
server rules and any account policy you choose for the benchmark. The local
shadow ladder remains the reproducible evaluation track when public ladder
conditions or account policy are not stable enough for apples-to-apples scoring.
