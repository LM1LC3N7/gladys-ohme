// -----------------------------------------------------------------------------
// The Ohme answers -> what the integration shows (pure).
//
// The status, the power readings, the battery, the target percentage and the
// charge slots follow ohmepy (MIT): `ChargerStatus` from the session `mode`
// and the power, `ChargerMode` from the `mode`, the battery from the car or
// the session, the target from the applied rule (or the suspended one, or the
// next session's rule).
// -----------------------------------------------------------------------------

import { API_MODES, LIMITS, MODES, STATUS } from './constants.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A finite number, else undefined. */
const finite = (value) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

/** A short printable text from an answer, else undefined. */
export function shortText(value, max = LIMITS.textLength) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // Control characters out, at most `max` characters.
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text === '' ? undefined : text.slice(0, max);
}

const SERIAL = /^[A-Za-z0-9_-]{1,64}$/;

/** The account -> the first charger (ohmepy uses `chargeDevices[0]`). */
export function readAccount(raw) {
  const device = Array.isArray(raw?.chargeDevices) ? raw.chargeDevices[0] : undefined;
  if (!isObject(device)) {
    return undefined;
  }
  const serial = typeof device.id === 'string' && SERIAL.test(device.id) ? device.id : undefined;
  if (!serial) {
    return undefined;
  }
  const name = shortText(device.modelTypeDisplayName);
  return {
    serial,
    name: name ?? 'Ohme',
    model: name ? name.replace(/^Ohme /, '') : undefined,
    firmware: shortText(device.firmwareVersionLabel, 40),
    chargers: raw.chargeDevices.length,
  };
}

/** ohmepy's `status`, plus `offline` when the API says the charger is not online. */
export function statusOf(session) {
  const mode = session?.mode;
  if (mode === API_MODES.PENDING_APPROVAL) {
    return STATUS.PENDING_APPROVAL;
  }
  if (mode === API_MODES.DISCONNECTED) {
    return STATUS.UNPLUGGED;
  }
  if (mode === API_MODES.STOPPED) {
    return STATUS.PAUSED;
  }
  if (mode === API_MODES.FINISHED_CHARGE) {
    return STATUS.FINISHED;
  }
  const watts = finite(session?.power?.watt);
  return watts !== undefined && watts > 0 ? STATUS.CHARGING : STATUS.PLUGGED_IN;
}

/** ohmepy's `mode`: the charge mode the select shows, undefined when there is none. */
export function modeOf(session) {
  switch (session?.mode) {
    case API_MODES.SMART_CHARGE:
      return MODES.SMART_CHARGE;
    case API_MODES.MAX_CHARGE:
      return MODES.MAX_CHARGE;
    case API_MODES.STOPPED:
      return MODES.PAUSED;
    default:
      return undefined;
  }
}

/** A charge is in progress (something is plugged in), as ohmepy's `_charge_in_progress`. */
export const inProgress = (status) =>
  status !== STATUS.UNPLUGGED && status !== STATUS.PENDING_APPROVAL;

const percent = (value) => {
  const number = finite(value);
  return number !== undefined && number >= 0 && number <= 100 ? Math.round(number) : undefined;
};

const ruleId = (rule) => {
  const id = rule?.id;
  if (typeof id === 'number' && Number.isSafeInteger(id)) {
    return String(id);
  }
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : undefined;
};

/** The planned charge slots: `{ start, end }` in ms, sorted. */
export function slotsOf(session) {
  const slots = Array.isArray(session?.allSessionSlots) ? session.allSessionSlots : [];
  return slots
    .map((slot) => ({ start: finite(slot?.startTimeMs), end: finite(slot?.endTimeMs) }))
    .filter(({ start, end }) => start !== undefined && end !== undefined && end > start)
    .sort((a, b) => a.start - b.start);
}

/**
 * The charge session (and the next session's rule) -> the snapshot shown.
 * `previous`: the last snapshot, for the energy of the session (ohmepy keeps
 * the highest reading of the session).
 */
export function readSnapshot({ session, nextRule = {}, previous }, now) {
  const status = statusOf(session);
  const online = isObject(session.chargerStatus) ? session.chargerStatus.online !== false : true;
  const power = isObject(session.power) ? session.power : {};
  const charging = inProgress(status);

  // The battery of the car, else of the session (ohmepy's `battery`).
  const battery = percent(session.car?.batterySoc?.percent) ?? percent(session.batterySoc?.percent);

  // The energy of the session: the highest `batterySoc.wh` seen while plugged
  // in. Unplugged, the last session's energy is kept as long as it is known.
  const wh = finite(session.batterySoc?.wh);
  let energyWh = previous?.energyWh;
  if (charging) {
    const continuing = Boolean(previous) && inProgress(previous.pluggedStatus);
    const reading = wh !== undefined && wh >= 0 ? wh : undefined;
    energyWh =
      reading === undefined
        ? continuing
          ? previous.energyWh
          : undefined
        : Math.max(reading, continuing ? (previous.energyWh ?? 0) : 0);
  }

  // The target percentage (ohmepy's `target_soc`).
  let target;
  let rule;
  if (status === STATUS.PAUSED && isObject(session.suspendedRule)) {
    target = percent(session.suspendedRule.targetPercent);
    rule = ruleId(session.appliedRule) ?? ruleId(session.suspendedRule);
  } else if (charging && isObject(session.appliedRule)) {
    target = percent(session.appliedRule.targetPercent);
    rule = ruleId(session.appliedRule);
  } else {
    target = percent(nextRule.targetPercent);
    rule = ruleId(nextRule);
  }

  const slots = slotsOf(session).filter((slot) => slot.end > now);
  return {
    status: online ? status : STATUS.OFFLINE,
    pluggedStatus: status,
    online,
    mode: modeOf(session),
    transient: session.mode === API_MODES.CALCULATING || session.mode === API_MODES.DELIVERING,
    watts: finite(power.watt) ?? 0,
    amps: finite(power.amp) ?? 0,
    volts: finite(power.volt),
    battery,
    energyWh,
    target,
    ruleId: rule ?? ruleId(nextRule),
    chargeEnd: slots.length > 0 ? Math.max(...slots.map((slot) => slot.end)) : undefined,
  };
}

/** The delay before the next read: a minute while charging (or computing), else 5 minutes. */
export function intervalOf(snapshot, { charging, idle }) {
  if (snapshot && (snapshot.pluggedStatus === STATUS.CHARGING || snapshot.transient)) {
    return charging;
  }
  return idle;
}

const formats = new Map();

/** "2026-10-18 06:30": the wall clock of `ms` in `timezone`. */
export function wallClock(ms, timezone) {
  let format = formats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formats.set(timezone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** Whether `timezone` is an IANA name this Node knows. */
export function validTimezone(timezone) {
  if (typeof timezone !== 'string' || timezone.trim() === '' || timezone.length > 64) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone.trim() });
    return true;
  } catch {
    return false;
  }
}
