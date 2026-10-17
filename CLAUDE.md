# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15), its only
runtime dependency (HTTPS goes through `node:https`). It signs in to the Ohme
cloud (Firebase, e-mail and password of the app), reads the charge session of
the first charger and shows it on one Gladys device; the charge mode and the
battery target can be changed behind an off-by-default option. Unofficial
API, never tested with a real account, not affiliated with Ohme.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `format:check`, `lint`, `test` (Node 22 and 24) and `audit` before every
commit.

## Architecture

```
index.js            SDK bootstrap only
src/handlers.js     every SDK handler -> the app (shared with the tests)
src/app.js          OhmeApp: cycle and its timer, failures, stops and pauses,
                    device, states, badge, the test button, the two commands
src/client.js       Firebase sign-in and renewal, reads (one renewal + retry), commands (never retried)
src/ohme.js         the only network access (node:https, bounded), errors (codes only)
src/model.js        answers -> status, mode, battery, energy, target, slots (pure)
src/devices.js      -> the Gladys device and its states (pure)
src/publisher.js    states within 300/min
src/store.js        /data/ohme-state.json: session, pause, stop (bounded to 24 h)
src/config.js       config_schema normalized, account key (hash of the e-mail)
src/constants.js    hosts, paths, modes, feature roles, limits, timings
src/i18n.js         runtime texts, feature, status and mode names (en/fr)
test/fixtures/      answers shaped like what ohmepy reads
test/helpers/       a fake Firebase + Ohme behind the transport; Gladys is the SDK's fake
```

## Rules

- **External ids are forever**: device `charger:<serial>`, features
  `status`, `connector-status`, `charging-state`, `power`, `current`,
  `voltage`, `session-energy`, `vehicle-battery`, `target-percent`,
  `charge-end`, `charge-mode`, `set-target-percent`.
- Manifest keys (`email`, `password`, `allow_commands`, `timezone`,
  `language`, the action `test_connection`) are frozen.
- **Commands**: never a switch nor a binary feature (a "turn everything off"
  must not reach them), refused unless `allow_commands`; a fresh read before
  acting, never sent after 3.5 s, never retried, one at a time.
- **Energy**: no cumulative index exists; never publish an `index`/`energy`
  feature nor `daily-consumption` (and never through publishStates).
- **Never sign in in a loop**: one sign-in per cycle at most, stops with
  spaced new tries (6 h, 24 h). 429 pauses every path. Never log or put in a
  message the password, a token, or the free text of an answer.
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`; a `secret`
  field is kept by Gladys in its database, never write that it is encrypted.
- Files are UTF-8 without BOM (`test/encoding.test.js`); tests never touch
  the network.
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` kept in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow.
