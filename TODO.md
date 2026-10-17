# TODO — Ohme v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  reserved in /t/10385 (post #241) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-17): Firebase sign-in, token renewal
      from the refresh token, session in `/data`, one device per account
      (first charger), status/connector/charging state, power, current,
      voltage, session energy, vehicle battery, target, planned end, mode
      and target selects behind `allow_commands` (off), polling 1 min / 5
      min, stops and pauses persisted and bounded, test button, docs en/fr,
      cover. Tested against made-up answers only.
- [ ] **Milestone 2 — real account**: run against a real account and charger
      (see "To check"), turn the answers (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: several chargers (one device each), charge
      approval button (`pluginsRequireApprovalMode`, off by default), target
      time, vehicle selection, price cap and solar mode (configuration
      switches in Home Assistant: here, if ever, as selects behind the option).

## To check on a real account

- The Firebase answers: `INVALID_LOGIN_CREDENTIALS` for a wrong password
  (the older `INVALID_PASSWORD`/`EMAIL_NOT_FOUND` are handled too); does the
  renewal accept the documented `grant_type`/`refresh_token` (ohmepy sends
  `grantType`/`refreshToken`; Google accepts both forms as far as known)?
- `/v1/chargeSessions`: one entry per charger? Does it carry the charger id
  (to pair sessions and chargers)? `chargerStatus.online`, `power.volt`,
  `batterySoc.wh` (energy delivered in the session, or the battery content?),
  `car.batterySoc.percent`, `allSessionSlots` times (ms, UTC).
- What the API answers to a refused token (401, or 403?), and to a command
  on an unplugged charger.
- `max-charge?enabled=false` while paused: does it resume? (Here: smart from
  a pause calls `resume`; max from a pause is refused.)
- The rule id to patch for the target: `appliedRule.id` during a session,
  `nextSessionInfo.rule.id` otherwise (as ohmepy).
- Rate limits: none documented; watch for 429, `Retry-After`.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-ohme:0.1.0`);
  the first patch release gives 0.1.1. `test/manifest.test.js` checks the
  four agree.
- **Own client on `node:https`, no Python**: ohmepy (MIT, the library of
  Home Assistant) ported to ~600 lines; the Home Assistant integration
  (Apache-2.0) for the sensors, the modes and the target. No npm client
  exists. Credited in README and `THIRD_PARTY_NOTICES.md` (full MIT notice,
  shipped in the image with `LICENSE`, the standard Apache-2.0 text without
  any name, as gladys-tedee). Runtime dependency: the SDK only.
- **Firebase API key** of the Ohme app copied from ohmepy: a public app
  identifier, not a secret. **User-Agent** honest (`gladys-ohme/0.1`), not
  ohmepy's.
- **Password**: in the Gladys `secret` field (kept by Gladys in its
  database, never shown again, sent only to Firebase). `/data` never holds the
  e-mail nor the password; it holds the tokens (0600), the account as
  `sha256(e-mail)[0..16]`, the 429/403 pause and the stop.
- **Token**: renewed from the refresh token after 45 minutes (ohmepy) or 5
  minutes before its expiry, never a sign-in per cycle. A refused refresh
  token signs in once (one sign-in per cycle at most). A token refused by
  the API (401, or 403 which may be one) is renewed once and the read
  retried once; refused again: `session_refused` (401) or a one-hour 403
  pause.
- **Stops (brief: "refus → arrêt, relance espacée bornée comme gladys-picnic")**:
  a refused e-mail/password or a rejected sign-in request (other 4xx: API key
  or protocol changed) stops, with one new try after 6 h then every 24 h
  (Picnic waits for the user; here a bounded timer too, wave-1 lesson "never
  dead without a timer", spaced so a wrong password cannot lock the
  account). A refused session: 1 h, 6 h, 24 h (as Picnic). Stops persisted
  in `/data` per account and bounded to 24 h at a restart; a change of
  credentials or the test button lifts them. `TOO_MANY_ATTEMPTS_TRY_LATER`
  is a one-hour pause, not a stop.
- **429**: `Retry-After` bounded to 1 min – 6 h, 15 min without it; applies
  to the polling, the button and the commands (also when it comes from a
  command, even answered in the background); persisted and kept across
  Gladys reconnections and account changes. **403** (after a renewal): one
  hour, same scope. **5xx/network**: 2, 5, 10, 15, then 30 minutes, never
  shorter than the current interval (an error is never read again faster).
- **Secondary reads**: `nextSessionInfo` (and the account once known) never
  hide the session; their failure is logged (code only), only a 429 pauses,
  after the data is shown.
- **Interval**: 60 s while charging (power > 0) or while Ohme computes the
  schedule (`CALCULATING`/`DELIVERING`), 5 min otherwise (brief). ohmepy's
  immediate re-reads of the transient modes (3 reads, 1 s apart) are not
  kept: the next read comes a minute later.
- **One charger**: `chargeDevices[0]` and `chargeSessions[0]` like ohmepy;
  a warning is logged when the account has several.
- **Features and units** (core `DEVICE_FEATURE_UNITS_BY_CATEGORY`):
  power/current/voltage on `energy-sensor` in W/A/V (instantaneous, never an
  index, like gladys-tibber); session energy on
  `electrical-vehicle-charge/last-charge-energy-added` in kWh; vehicle
  battery `electrical-vehicle-battery/battery-level` in %; target
  `electrical-vehicle-charge/target-charge-limit` in % (read only); connector
  and charging state on the core's `charging-station` category (values of
  `CHARGING_STATION_CONNECTOR_STATUS` / `_CHARGING_STATE`, copied in
  `src/devices.js`). Status and planned end as `text`. All fixed at creation.
- **Charging state when unplugged: IDLE** (the core leaves it "without
  value" outside a session; a stale "charging" would mislead scenes).
  Offline (`chargerStatus.online` false): connector UNAVAILABLE, status
  "Charger offline", no power/current/voltage published, badge unreachable.
- **Energy**: Ohme gives no cumulative index (only `batterySoc.wh` of the
  session, reset at each session): no `index`/`energy` feature, no
  `publishEnergyConsumption`, no `daily-consumption`. The lifetime total of
  the charge summary endpoint was not used (unknown behaviour, an extra
  call). The session energy is the highest reading of the session and stays
  shown after unplugging until the next session.
- **Vehicle battery**: feature always created, state published only when
  Ohme gives a percentage (car first, then session, as ohmepy).
- **Commands** (`allow_commands`, off by default): two `text`/`select`
  features, never switch/binary (a "turn everything off" from Google Home,
  Alexa, HomeKit, MCP or a scene must not reach them). Mode: smart / max /
  paused (Home Assistant's select); smart from a pause calls `resume`; max
  from a pause is refused ("smart first", behaviour of `max-charge` on a
  paused session unknown); nothing plugged in: refused. Target: 10 % to
  100 % by 5 % (a select, not a number, per the brief), `PATCH` of the
  applied rule (or the next session's rule). A fresh session read before
  each command (never decided on memory), nothing sent when already so, one
  command at a time, never retried. Timing for the 5 s ack: the read and the
  sign-in/renewal it may need must leave room to send by 3.5 s, else refused
  unsent; Gladys is answered at 4.3 s at the latest, the request finishing in
  the background (logged, its 429 still pauses). A read 10 s after a command
  shows its effect.
- **Test button**: at most once per 30 s, 8 s requests (worst case: sign-in,
  account, renewal and retry, session, next ≈ 6 × 8 s < 60 s), answers "in
  progress" during a running read, respects the 429/403 pause, lifts a stop
  for one try.
- **Timezone** for the planned end: a configuration field (default
  Europe/Paris), as gladys-entsoe: the container's time zone is not the
  user's.
- **Reconnection to Gladys** (`connected`): republishes the status, the
  device, the states and the badge; never clears the pauses, the stops nor
  the session.
- **gladys_version >= 4.86.0**: the store `categories` and `text/select`
  (4.86.0), `charging-station` (4.85.0).
- **Category `energy`** in the store.
- **Not checked here (PIPELINE step 1, main session)**: duplicates in the
  store, the core and the forum were checked when the batch was reserved
  (post #241). No Docker on this PC: the image was not built locally.
