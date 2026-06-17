# GPT-5.5 First Run

This benchmark starts with one model entry, `gpt-5.5`.

## One Command

Create `.env` from `.env.example`, add `OPENAI_API_KEY`, then run:

```bash
pnpm run gpt55
```

This builds a validated team at `data/teams/gpt-5.5.txt` and writes the
Champion Track result to `results/gpt-5.5-champion.json`.

## 1. Build A Team

```bash
OPENAI_API_KEY=... node src/cli.js build-team \
  --model gpt-5.5 \
  --out data/teams/gpt-5.5.txt \
  --attempts 3
```

The command asks the model for a Showdown importable, validates it against the
frozen Champions OU format, and feeds validation errors back to the model for a
limited repair loop.

## 2. Run A Baseline Match

```bash
OPENAI_API_KEY=... node src/cli.js match \
  --agent-a openai \
  --model-a gpt-5.5 \
  --team-a data/teams/gpt-5.5.txt \
  --agent-b heuristic \
  --team-b data/teams/baseline.txt \
  --games 10 \
  --out results/gpt-5.5-vs-heuristic.json
```

## 3. Run Champion Elo

Create a manifest:

```json
{
  "name": "champions-ou-gpt-5.5",
  "format": "[Gen 9 Champions] OU",
  "gamesPerPairing": 20,
  "seed": 20260616,
  "players": [
    {
      "id": "gpt-5.5",
      "type": "openai",
      "model": "gpt-5.5",
      "teamFile": "data/teams/gpt-5.5.txt"
    },
    {
      "id": "heuristic-baseline",
      "type": "heuristic",
      "teamFile": "data/teams/baseline.txt"
    },
    {
      "id": "random-baseline",
      "type": "random",
      "teamFile": "data/teams/baseline-alt.txt"
    }
  ]
}
```

Run it:

```bash
OPENAI_API_KEY=... node src/cli.js tournament \
  --manifest config/benchmark.gpt-5.5.json \
  --out results/gpt-5.5-champion.json
```
