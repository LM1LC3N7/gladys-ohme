// -----------------------------------------------------------------------------
// The pure parts: answers -> snapshot, device and states, configuration, the
// persisted state.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULTS, normalizeConfig } from '../src/config.js';
import { STATUS, TIMINGS } from '../src/constants.js';
import {
  DEFINITIONS,
  buildDevice,
  chargerIds,
  chargingStateOf,
  deviceStates,
} from '../src/devices.js';
import {
  intervalOf,
  modeOf,
  readAccount,
  readSnapshot,
  shortText,
  statusOf,
  validTimezone,
  wallClock,
} from '../src/model.js';
import { normalizeMemory } from '../src/store.js';
import {
  HOUR,
  MINUTE,
  NOW,
  SERIAL,
  account,
  charging,
  nextRule,
  paused,
  unplugged,
} from './fixtures/ohme.js';

test('statuses and modes as ohmepy reads them', () => {
  assert.equal(statusOf({ mode: 'PENDING_APPROVAL' }), STATUS.PENDING_APPROVAL);
  assert.equal(statusOf({ mode: 'DISCONNECTED' }), STATUS.UNPLUGGED);
  assert.equal(statusOf({ mode: 'STOPPED' }), STATUS.PAUSED);
  assert.equal(statusOf({ mode: 'FINISHED_CHARGE' }), STATUS.FINISHED);
  assert.equal(statusOf({ mode: 'SMART_CHARGE', power: { watt: 10 } }), STATUS.CHARGING);
  assert.equal(statusOf({ mode: 'SMART_CHARGE', power: { watt: 0 } }), STATUS.PLUGGED_IN);
  assert.equal(statusOf({ mode: 'CALCULATING' }), STATUS.PLUGGED_IN);
  assert.equal(modeOf({ mode: 'MAX_CHARGE' }), 'max_charge');
  assert.equal(modeOf({ mode: 'SMART_CHARGE' }), 'smart_charge');
  assert.equal(modeOf({ mode: 'STOPPED' }), 'paused');
  assert.equal(modeOf({ mode: 'DISCONNECTED' }), undefined);
});

test('the account: the first charger, a safe serial', () => {
  assert.deepEqual(readAccount(account()), {
    serial: SERIAL,
    name: 'Ohme Home Pro',
    model: 'Home Pro',
    firmware: 'v2.70',
    chargers: 1,
  });
  assert.equal(readAccount({ chargeDevices: [] }), undefined);
  assert.equal(readAccount({ chargeDevices: [{ id: '../x' }] }), undefined);
  assert.equal(shortText('a\u0000b'.padEnd(200, 'c')).length, 60);
});

test('the snapshot: battery, target, energy kept during the session, planned end', () => {
  const first = readSnapshot({ session: charging(), nextRule: nextRule().rule }, NOW);
  assert.equal(first.battery, 56, 'the car battery first');
  assert.equal(first.target, 80, 'the applied rule while charging');
  assert.equal(first.ruleId, 'rule-1');
  assert.equal(first.energyWh, 4520);
  assert.equal(first.chargeEnd, NOW + 3 * HOUR + 30 * MINUTE);
  const lower = readSnapshot(
    { session: charging(NOW, { batterySoc: { wh: 4480 } }), previous: first },
    NOW,
  );
  assert.equal(lower.energyWh, 4520, 'the highest reading of the session');
  const dropped = readSnapshot(
    { session: charging(NOW, { batterySoc: { wh: 150 } }), previous: lower },
    NOW,
  );
  assert.equal(dropped.energyWh, 150, 'a clear drop is a new session');
  const out = readSnapshot(
    { session: unplugged(), nextRule: nextRule().rule, previous: lower },
    NOW,
  );
  assert.equal(out.energyWh, 4520, 'kept once unplugged');
  assert.equal(out.target, 70, 'the next session target');
  assert.equal(out.battery, undefined);
  const again = readSnapshot(
    { session: charging(NOW, { batterySoc: { wh: 300 } }), previous: out },
    NOW,
  );
  assert.equal(again.energyWh, 300, 'a new session starts from its own reading');
  const stopped = readSnapshot({ session: paused() }, NOW);
  assert.equal(stopped.target, 90, 'the suspended rule while paused');
  assert.equal(stopped.mode, 'paused');
  const done = readSnapshot({ session: charging(NOW, { allSessionSlots: [] }) }, NOW + DAY());
  assert.equal(done.chargeEnd, undefined);
});

const DAY = () => 24 * HOUR;

test('the interval: a minute while charging or computing, 5 minutes otherwise', () => {
  const timings = { charging: TIMINGS.chargingInterval, idle: TIMINGS.idleInterval };
  assert.equal(intervalOf(readSnapshot({ session: charging() }, NOW), timings), MINUTE);
  assert.equal(intervalOf(readSnapshot({ session: unplugged() }, NOW), timings), 5 * MINUTE);
  assert.equal(
    intervalOf(
      readSnapshot({ session: charging(NOW, { mode: 'CALCULATING', power: {} }) }, NOW),
      timings,
    ),
    MINUTE,
  );
  assert.equal(intervalOf(undefined, timings), 5 * MINUTE);
});

test('times in the configured timezone', () => {
  assert.equal(wallClock(NOW, 'Europe/Paris'), '2026-10-17 14:00');
  assert.equal(wallClock(NOW, 'Europe/London'), '2026-10-17 13:00');
  assert.ok(validTimezone('Europe/Brussels'));
  assert.ok(!validTimezone('Mars/Olympus'));
});

test('device: frozen ids, core units, commands as selects only', () => {
  const gladys = createFakeGladys({});
  const device = buildDevice(gladys, readAccount(account()), { language: 'en' });
  const ids = chargerIds(gladys, SERIAL);
  assert.equal(device.external_id, ids.device);
  // DEVICE_FEATURE_UNITS_BY_CATEGORY of the core (server/utils/constants.js), for our categories.
  const allowed = {
    'energy-sensor': [
      'milliampere',
      'ampere',
      'millivolt',
      'volt',
      'watt',
      'kilowatt',
      'watt-hour',
      'kilowatt-hour',
    ],
    'electrical-vehicle-charge': [
      'ampere',
      'kilowatt',
      'kilowatt-hour',
      'megawatt-hour',
      'percent',
      'volt',
    ],
    'electrical-vehicle-battery': [
      'celsius',
      'fahrenheit',
      'kilowatt',
      'kilowatt-hour',
      'km',
      'mile',
      'percent',
      'volt',
    ],
  };
  for (const f of device.features) {
    if (f.unit !== undefined) {
      assert.ok(
        allowed[f.category]?.includes(f.unit),
        `${f.external_id}: ${f.unit} on ${f.category}`,
      );
    }
    assert.ok(f.category !== 'switch' && f.type !== 'binary');
  }
  assert.equal(Object.keys(DEFINITIONS).length + 2, device.features.length);
  const states = deviceStates(ids, readSnapshot({ session: unplugged() }, NOW), {
    language: 'en',
    timezone: 'Europe/Paris',
  });
  assert.ok(!states.some((s) => s.device_feature_external_id === ids.feature('charge-mode')));
  assert.equal(chargingStateOf({ pluggedStatus: STATUS.PENDING_APPROVAL }), 3);
});

test('configuration: commands off unless set, defaults', () => {
  const config = normalizeConfig({ email: ' a@b.c ', password: 'x' });
  assert.equal(config.allowCommands, false);
  assert.equal(config.timezone, DEFAULTS.timezone);
  assert.equal(config.language, 'fr');
  assert.equal(normalizeConfig({ allow_commands: 'yes' }).allowCommands, false);
  assert.equal(normalizeConfig({ allow_commands: true }).allowCommands, true);
  assert.equal(normalizeConfig({ timezone: 'Nowhere/Land' }).timezone, 'Europe/Paris');
});

test('/data: pauses and stops bounded to 24 h, junk dropped', () => {
  const memory = normalizeMemory(
    {
      pause: { kind: 'rate', until: NOW + 100 * HOUR },
      block: { account: 'abc', kind: 'refused', retryAt: NOW + 100 * HOUR, retries: 99 },
      session: { account: 'abc', idToken: 'x', refreshToken: 'y', expiresAt: 'soon' },
    },
    NOW,
  );
  assert.equal(memory.pause.until, NOW + 24 * HOUR);
  assert.equal(memory.block.retryAt, NOW + 24 * HOUR);
  assert.equal(memory.block.retries, 10);
  assert.equal(memory.session.expiresAt, 0);
  const junk = normalizeMemory(
    { pause: { kind: 'other', until: NOW + HOUR }, block: { kind: 'x' } },
    NOW,
  );
  assert.equal(junk.pause, null);
  assert.equal(junk.block, null);
  assert.equal(normalizeMemory({ pause: { kind: 'rate', until: NOW - 1 } }, NOW).pause, null);
});
