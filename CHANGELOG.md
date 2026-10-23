# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-23

## [0.1.1] - 2026-10-17

### Added

- Sign-in to the Ohme cloud with the e-mail and the password of the Ohme app
  (Firebase, like ohmepy); the token renewed from the refresh token and kept
  in `/data`, no sign-in per cycle.
- One device for the first charger of the account: status, connector and
  charging state (charging-station category), power, current, voltage,
  energy of the session, vehicle battery when Ohme gives it, battery target
  and planned end of charge.
- Charge mode (smart, max charge, paused) and battery target (10 % to 100 %)
  as selects, refused unless "Allow the commands" is on (off by default);
  each command reads the charger first and is answered within Gladys' 5 s.
- Reads every minute while charging, every 5 minutes otherwise.
- Resilience: a refused password stops with one new try after 6 h then every
  24 h; a refused session after 1 h, 6 h, 24 h; 429 pauses every path (1
  minute to 6 hours), 403 one hour, kept in `/data`; 5xx and network errors
  retried after 2 to 30 minutes.
- "Test the connection" button; documentation in English and French;
  `LICENSE` and `THIRD_PARTY_NOTICES.md` shipped in the image.

[Unreleased]: https://github.com/LM1LC3N7/gladys-ohme/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-ohme/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-ohme/releases/tag/v0.1.1
