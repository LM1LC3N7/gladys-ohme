# gladys-ohme

[Gladys Assistant](https://gladysassistant.com) external integration for
**Ohme** EV chargers (Home, Home Pro, ePod; UK and EU) through the Ohme
cloud: status, connector and charging state, power, current, voltage, energy
of the session, vehicle battery, battery target and planned end of charge;
the charge mode and the battery target can be changed behind an
off-by-default option. **Unofficial API, never tested with a real account.
Not affiliated with Ohme.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (OhmeApp)
                                  ├─ src/client.js     Firebase sign-in, token renewal, reads, commands
                                  ├─ src/ohme.js       the only HTTP access, errors (codes only)
                                  ├─ src/model.js      answers -> status, mode, battery, target, slots (pure)
                                  ├─ src/devices.js    the device and its states (pure)
                                  ├─ src/publisher.js  states within 300/min
                                  └─ src/store.js      /data/ohme-state.json
```

- **Sign-in** (as ohmepy): Firebase `verifyPassword` with the e-mail and the
  password; the `idToken` goes in `Authorization: Firebase <token>` on
  `api.ohme.io`, and is renewed from the refresh token after 45 minutes
  (`securetoken.googleapis.com`): no sign-in per cycle. The session is kept
  in `/data` with a hash of the e-mail, so a restart does not sign in.
- **Reads**: `/v1/chargeSessions` (main) and
  `/v1/chargeSessions/nextSessionInfo` (secondary: its failure never hides the
  session) every minute while charging, every 5 minutes otherwise;
  `/v1/users/me/account` once, then every 30 minutes.
- **Commands** (`allow_commands`, off by default): `text`/`select` features
  only, never a switch nor a binary. Each command reads the session first,
  is sent within 3.5 s of the click or refused unsent, and Gladys is answered
  within 4.3 s; one at a time; never retried.
- **Errors**: a refused password or sign-in request stops, one new try after
  6 h then every 24 h; a token refused right after a renewal: 1 h, 6 h, then
  24 h; 429: `Retry-After` bounded to 1 min – 6 h (15 min without), every
  path; 403: one hour; 5xx/network: 2 to 30 minutes, never under the
  interval. Pauses and stops are kept in `/data`, bounded to 24 h at a
  restart. Logs carry error codes only.
- **Energy**: no cumulative index exists in the API: no `index`, no
  `publishEnergyConsumption`, no daily consumption. The session energy is a
  plain `electrical-vehicle-charge` sensor.

## Credits

The Firebase sign-in, the token renewal, the endpoints and the reading of the
session are ported from [ohmepy](https://github.com/dan-r/ohmepy) (Daniel
Raper, MIT); the sensors, modes and target from the
[Home Assistant Ohme integration](https://github.com/home-assistant/core/tree/dev/homeassistant/components/ohme)
(Apache-2.0). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Modelled
on the sibling integrations
[gladys-picnic](https://github.com/LM1LC3N7/gladys-picnic) (cloud sign-in) and
[gladys-tibber](https://github.com/LM1LC3N7/gladys-tibber) (energy).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never touch the network: Firebase and Ohme are a fake behind the
injected transport, Gladys is the SDK's fake; `test/ohme.test.js` runs the
real transport against a loopback server.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from MIT and Apache-2.0
projects, credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also
shipped in the Docker image).
