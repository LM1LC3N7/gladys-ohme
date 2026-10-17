# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the two projects below. The ported
parts were rewritten, not copied; the changes are described below.

## ohmepy

<https://github.com/dan-r/ohmepy> (package `ohme`), by Daniel Raper. MIT
License (`LICENSE` of the repository, version 1.9.2). Its notice:

```
MIT License

Copyright (c) 2024 Daniel Raper

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Ported in `src/constants.js`, `src/ohme.js`, `src/client.js` and
`src/model.js`: the Firebase web API key of the Ohme app, the sign-in
(`verifyPassword` with the e-mail, the password and `returnSecureToken`), the
token renewal from the refresh token (`securetoken.googleapis.com`) after 45
minutes, the `Authorization: Firebase <token>` header, the `user_id` claim,
the endpoints (`/v1/users/me/account`, `/v1/chargeSessions`,
`/v1/chargeSessions/nextSessionInfo`, `stop`, `resume`, `max-charge`,
`/v2/users/me/charge-rules/<id>`), the charger status and mode from the
session `mode` and the power, the battery, the energy of the session, the
target percentage and the charge slots. Changed: the renewal form fields are
the documented `grant_type`/`refresh_token`; a refused refresh token signs in
once per cycle at most; the transient `CALCULATING`/`DELIVERING` modes are
not read again at once (the next read comes a minute later); a 429, a 403,
a refused password and a refused session stop or pause with bounded, spaced
new tries; an `offline` status when the API says the charger is not online.

## Home Assistant, Ohme integration

<https://github.com/home-assistant/core>, `homeassistant/components/ohme`, by
the Home Assistant authors (Dan Raper's integration, moved into the core).
Apache License 2.0 (the same text as `LICENSE`; no `NOTICE` file).

Ported in `src/devices.js` and `src/app.js`: the sensors shown (status,
power, current, voltage, vehicle battery), the charge mode select (smart,
max, paused), the target percentage, the charge sessions read every 30 s
and the account every 30 minutes. Changed: the session is read every
minute while charging and every 5 minutes otherwise; the mode and the target
are refused unless the configuration allows them; the target is a choice of
10 % to 100 % by 5 %; the planned end of charge is the end of the last
planned slot.
