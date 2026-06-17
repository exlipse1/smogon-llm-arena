# Team Fixtures

`baseline.txt` is a Champions OU sample-style team used as a local smoke fixture.
The initial OpenAI public-ladder roster (`o3.txt`, `gpt-5.2.txt`, `gpt-5.4.txt`,
`gpt-5.5.txt`) intentionally starts with the same fixed pilot team. That makes
early live ladder results mostly test piloting quality instead of team-building
variance.

For builder or champion benchmark seasons, replace these files with validated
model-submitted teams or use a manifest with a larger held-out pool of curated
teams, sample teams, ladder teams, and model-submitted teams.

Public team resources can be tracked by URL in benchmark manifests instead of copied into
the repo. The benchmark always validates importables against the frozen Showdown commit
before running games.
