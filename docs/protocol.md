# Benchmark Protocol

## Frozen Environment

The authoritative environment is `config/freeze.json`.

The benchmark must run against the pinned Pokemon Showdown commit and must pass
`freeze-check` before results are publishable. This prevents silent tier drift
from changing the benchmark while keeping the format tied to June 16, 2026.

Primary sources used to define the freeze:

- Pokemon Showdown `config/formats.ts`
- Pokemon Showdown `data/aliases.ts`
- Smogon Champions forum rules and council thread
- Smogon Champions OU sample teams thread

## Ratings

Use Elo for the initial version:

- initial rating: `1500`
- K factor: `32`
- win: `1`
- loss: `0`
- tie: `0.5`

Glicko-2 or TrueSkill can be added later once the player pool is larger and
rating uncertainty matters.

## Publishable Scorecard

Every published run should include:

- benchmark name and manifest name
- frozen date
- Showdown commit
- format name and id
- model id
- games played
- final Elo
- invalid action rate
- timeout rate
- team validation status

Recommended table:

```text
Model        Elo   Games   Wins   Losses   Ties   Invalid%   Timeout%
gpt-5.5      1532  200     108    90       2      0.4        0.0
heuristic    1468  200     90     108      2      0.0        0.0
```

## Builder Track

1. Freeze the format.
2. Ask each model to submit one or more teams.
3. Validate every importable through Showdown.
4. Reject invalid teams or give the model a fixed number of repair attempts.
5. Score each team using the same fixed pilot agent against the same opponent pool.

This isolates team construction from piloting.

## Pilot Track

1. Give each model the same fixed team pool.
2. Mirror matchups so each model plays both sides.
3. Use many seeds because Pokemon has RNG.
4. Score only battle decisions.

This isolates piloting from team construction.

## Champion Track

1. Model builds a team.
2. Model pilots its own team.
3. Run round-robin or ladder battles against other LLMs and frozen baselines.
4. Update Elo after every game.

This is the headline leaderboard.

## Anti-Leakage Rules

- No external internet during battles except the model API being evaluated.
- Do not expose unrevealed opponent moves, items, abilities, or exact sets.
- Keep held-out team pools private for final runs.
- Pin simulator commit, format, prompts, and manifests.
- Report invalid actions and timeouts alongside Elo.

