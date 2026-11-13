# Security

Report a vulnerability privately, through GitHub: the repository's
**Security** tab, **Report a vulnerability**. Please do not open a public
issue for it.

## What to know before you run testsky

- **Screens go to your model.** Every look a run takes -- the screenshot and,
  when there is one, the accessibility tree -- is sent to the model endpoint
  you configure. Do not point testsky at a screen whose contents may not go
  there. When they may not leave the machine, give every tier a local
  endpoint (vLLM, ollama): testsky sends model calls to the endpoints you
  configure and nowhere else. `offline: true` in `~/.testsky/models.yaml`
  does not check this for you: it refuses only a host that no tier names, so
  a cloud endpoint you configured is still called.
- **Reports keep everything.** A run's folder and its report hold every frame
  and every word the run typed, Wi-Fi keys and passwords in a step included.
  testsky has no secret steps, on purpose: treat run folders as you would the
  test's own credentials.
- **The model key stays where you put it.** testsky reads it from its
  environment or a `.env` where it runs; `~/.testsky/models.yaml` holds only
  the name of the variable (`api_key_env`). The key is no part of a report or
  a run's folder.
- **`testsky mcp` serves whoever started it**, over stdio. It uses only the
  phones it is given with `--devices`, never takes a phone another run holds,
  and cannot accept or reject a heal. What a model or an agent reads off a
  screen is the app's text: an agent should treat it as data, not as
  instructions.
