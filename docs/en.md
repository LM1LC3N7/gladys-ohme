# Ohme for Gladys

Shows your **Ohme** EV charger (Home, Home Pro, ePod; United Kingdom and
Europe) in Gladys, through the Ohme cloud, with the account of the Ohme app.

> **Unofficial API, never tested with a real account nor a real charger.**
> The integration talks to the API of the Ohme app, like the ohmepy library
> and the Home Assistant integration. Ohme may change it without notice. Not
> affiliated with Ohme.

## What you get

One device per account (the first charger of the account) with:

| Feature                | Content                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Status                 | Unplugged, Plugged in, Charging, Paused, Finished, Waiting for approval, Charger offline |
| Connector              | Available, occupied or unavailable (Gladys "charging station" category)                  |
| Charging state         | Charging, vehicle connected, paused, idle                                                |
| Power                  | In W                                                                                     |
| Current                | In A                                                                                     |
| Voltage                | In V, when Ohme gives it                                                                 |
| Energy of the session  | In kWh: the energy of the session in progress, then of the last session                  |
| Vehicle battery        | In %, only when Ohme gives it                                                            |
| Battery target         | In %, of the session in progress or of the next one                                      |
| Planned end of charge  | End of the last planned slot, e.g. "2026-10-18 06:30", else "—"                          |
| Charge mode            | Choice: smart charge, max charge, paused                                                 |
| Set the battery target | Choice: 10 % to 100 % by 5 %                                                             |

Read **every minute while charging**, every 5 minutes otherwise; the account
(model, firmware) every 30 minutes.

**Energy**: Ohme gives no cumulative meter, only the energy of the session.
The integration therefore publishes **no index** nor daily consumption: the
energy of the session is a plain sensor, outside the Gladys energy
monitoring (your main meter already counts the charger).

## Setup

1. Install the integration from the Gladys store.
2. In its configuration, enter the **e-mail** and the **password** of the
   Ohme app. The password is kept by Gladys in its database, never shown
   again, sent only to the Ohme sign-in service (Google Firebase, as the app
   does).
3. Check the **timezone** (Europe/Paris by default): it is used for the
   planned end of charge.
4. Save, then add the charger from the **Discovery** tab.

The **Test the connection** button reads the charger once (at most every 30
seconds).

## Commands (off by default)

The "Charge mode" and "Set the battery target" features refuse every command
while **Allow the commands** is off. On:

- **Max charge**: charges now at full power;
- **Smart charge**: back to Ohme's schedule; from a pause, resumes the charge;
- **Paused**: pauses the charge. From a pause, choose "Smart charge" first
  (max charge is refused);
- **Battery target**: changes the target of the session in progress, or of
  the next one when nothing is plugged in.

They are choices, never switches: a "turn everything off" does not reach
them. Google Home, Alexa and HomeKit do not see them, and the Gladys MCP
server only reads them. A scene can change them, but only through an
explicit action on that choice, and only when the commands are allowed.

Before each command, the integration reads the charger again (and the rule
of the next session for a target); a useless command (already in that mode)
is not sent; a command without a plugged-in vehicle, with the charger
offline or with the charge waiting for approval is refused. A command that
cannot leave within 3.5 seconds is refused unsent. Gladys gets an answer
after 4.3 seconds at most, even before Ohme confirmed: the real state shows
about 10 seconds later. One command at a time.

## Errors and limits

- **E-mail or password refused**: the integration stops and says so; one new
  try after 6 h, then every 24 h (not to lock the account). Saving new
  credentials or the test button try again at once.
- **Token refused**: renewed once; refused again, a pause then one try after
  1 h, 6 h, then every 24 h.
- **429 (too many requests)**: a pause of 1 minute to 6 hours (15 minutes
  without a hint), for everything (reads, button, commands), kept across a
  restart. **403** of the main read: one hour; 403 on a command: that command
  only is refused; 403 on a secondary read: that endpoint is skipped for an
  hour.
- **Network, 5xx**: new try after 2, 5, 10, 15, then 30 minutes, never faster
  than the interval.
- Stops and pauses are kept in `/data`, for 24 h at most. `/data` also keeps
  the Ohme session token, in clear, in a file reserved to the container user
  (0600), so also readable by the administrator of the machine and in the
  backups of the volume; never the e-mail nor the password.
- **Charger offline**: the connector turns "unavailable"; power, current,
  voltage and charging state keep their last value.
- **One charger**: with several chargers, only the first one is shown (as
  ohmepy).
- Charge approval, the schedule (target time), solar mode and the price cap
  are not supported.
- The logs never hold the password, the tokens, nor the text of Ohme's answers.

## Credits

Ported from [ohmepy](https://github.com/dan-r/ohmepy) (Daniel Raper, MIT) and
the [Home Assistant Ohme integration](https://github.com/home-assistant/core/tree/dev/homeassistant/components/ohme)
(Apache-2.0). Apache-2.0 license.
