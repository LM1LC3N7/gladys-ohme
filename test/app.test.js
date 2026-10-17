// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake Firebase + Ohme behind the transport. Timers and Date are
// mocked: the tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { OhmeApp } from '../src/app.js';
import { accountKey } from '../src/config.js';
import { ACTIONS, FIREBASE_API_KEY, TIMINGS } from '../src/constants.js';
import { CHARGING_STATE, CONNECTOR_STATUS } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import {
  EMAIL,
  HOUR,
  MINUTE,
  NOW,
  PASSWORD,
  SERIAL,
  charging,
  paused,
  unplugged,
} from './fixtures/ohme.js';
import { fakeOhme, memoryStore, settle } from './helpers/fakeOhme.js';

const CONFIG = { email: EMAIL, password: PASSWORD };
const ACCOUNT = accountKey(EMAIL);
const DEVICE = `ext:test-integration:charger:${SERIAL}`;
const feature = (role) => `${DEVICE}:${role}`;

async function setup(
  t,
  {
    config = CONFIG,
    store = memoryStore(),
    server = fakeOhme(),
    now = NOW,
    create = true,
    logs = [],
  } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const gladys = createFakeGladys({ config });
  const app = new OhmeApp({
    gladys,
    logger: recorder(logs),
    transport: server.transport,
    now: () => Date.now(),
    store,
  });
  registerHandlers(gladys, app);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  const advance = async (ms, step = 10_000) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  if (create && gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    await settle();
  }
  return { gladys, app, server, store, advance, logs };
}

/** A logger keeping every line, to check that no secret ever reaches the logs. */
const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

const last = (gladys, role) => gladys.fake.lastState(feature(role));
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const deviceOf = (gladys) => gladys.fake.discoveredDevices.at(-1);
const featureOf = (gladys, role) =>
  deviceOf(gladys).features.find((f) => f.external_id === feature(role));
const routes = (server) => server.requests.map((r) => `${r.method} ${r.host}${r.path}`);

test('without credentials, the status asks for them and nothing is requested', async (t) => {
  const { gladys, server } = await setup(t, { config: { email: EMAIL } });
  assert.equal(server.requests.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /e-mail and the password/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.fr, /mot de passe/);
  assert.equal(server.requests.length, 0);
});

test('one sign-in, then the account, the session and the next rule: device, states, status', async (t) => {
  const logs = [];
  const { gladys, server, store } = await setup(t, { logs });
  assert.deepEqual(routes(server), [
    'POST www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword',
    'GET api.ohme.io/v1/users/me/account',
    'GET api.ohme.io/v1/chargeSessions',
    'GET api.ohme.io/v1/chargeSessions/nextSessionInfo',
  ]);
  const [signIn] = server.signIns();
  assert.equal(signIn.query.key, FIREBASE_API_KEY);
  assert.deepEqual(signIn.form, { email: EMAIL, password: PASSWORD, returnSecureToken: 'true' });
  assert.match(server.api()[0].headers.Authorization, /^Firebase ey/);
  assert.match(server.api()[0].headers['User-Agent'], /^gladys-ohme\//);

  const saved = JSON.stringify(store.data);
  assert.ok(!saved.includes(PASSWORD), 'the password never reaches /data');
  assert.ok(!saved.includes(EMAIL), 'nor the e-mail');
  assert.equal(store.data.session.account, ACCOUNT);

  const device = deviceOf(gladys);
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.name, 'Ohme Home Pro');
  assert.equal(device.model, 'Home Pro');
  assert.deepEqual(
    device.features.map((f) => [
      f.external_id.slice(DEVICE.length + 1),
      f.category,
      f.type,
      f.unit,
      f.read_only,
    ]),
    [
      ['status', 'text', 'text', undefined, true],
      ['connector-status', 'charging-station', 'connector-status', undefined, true],
      ['charging-state', 'charging-station', 'charging-state', undefined, true],
      ['power', 'energy-sensor', 'power', 'watt', true],
      ['current', 'energy-sensor', 'current', 'ampere', true],
      ['voltage', 'energy-sensor', 'voltage', 'volt', true],
      [
        'session-energy',
        'electrical-vehicle-charge',
        'last-charge-energy-added',
        'kilowatt-hour',
        true,
      ],
      ['vehicle-battery', 'electrical-vehicle-battery', 'battery-level', 'percent', true],
      ['target-percent', 'electrical-vehicle-charge', 'target-charge-limit', 'percent', true],
      ['charge-end', 'text', 'text', undefined, true],
      ['charge-mode', 'text', 'select', undefined, false],
      ['set-target-percent', 'text', 'select', undefined, false],
    ],
  );
  assert.ok(
    device.features.every((f) => !['switch', 'binary'].includes(f.category) && f.type !== 'binary'),
    'no switch nor binary: "turn everything off" reaches no command',
  );
  assert.deepEqual(
    featureOf(gladys, 'charge-mode').supported_options.map((o) => [o.value, o.label]),
    [
      ['smart_charge', 'Charge intelligente'],
      ['max_charge', 'Charge maximale'],
      ['paused', 'En pause'],
    ],
  );

  assert.equal(last(gladys, 'status'), 'En charge');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.OCCUPIED);
  assert.equal(last(gladys, 'charging-state'), CHARGING_STATE.CHARGING);
  assert.equal(last(gladys, 'power'), 7200);
  assert.equal(last(gladys, 'current'), 31.3);
  assert.equal(last(gladys, 'voltage'), 230);
  assert.equal(last(gladys, 'session-energy'), 4.52);
  assert.equal(last(gladys, 'vehicle-battery'), 56);
  assert.equal(last(gladys, 'target-percent'), 80);
  assert.equal(last(gladys, 'set-target-percent'), '80');
  assert.equal(last(gladys, 'charge-mode'), 'smart_charge');
  // The last planned slot ends at 15:30 UTC = 17:30 in Paris.
  assert.equal(last(gladys, 'charge-end'), '2026-10-17 17:30');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).fr, /Connecté à Ohme \(En charge\)/);
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.CLOUD);
  assert.equal(gladys.fake.publishedEnergyConsumption.length, 0, 'no energy consumption');
  for (const secret of [PASSWORD, EMAIL, ...server.secrets]) {
    assert.ok(!logs.join('\n').includes(secret), 'no secret in the logs');
  }
});

test('a read every minute while charging, every 5 minutes otherwise; the token renewed, never a new sign-in', async (t) => {
  const { server, advance } = await setup(t);
  await advance(MINUTE);
  assert.equal(server.of('/v1/chargeSessions').length, 2, 'one minute later while charging');
  server.session = unplugged();
  await advance(MINUTE);
  assert.equal(server.of('/v1/chargeSessions').length, 3);
  await advance(4 * MINUTE);
  assert.equal(server.of('/v1/chargeSessions').length, 3, 'idle: not before 5 minutes');
  await advance(MINUTE);
  assert.equal(server.of('/v1/chargeSessions').length, 4);
  // 45 minutes after the sign-in, the token is renewed from the refresh token.
  await advance(45 * MINUTE);
  assert.equal(server.signIns().length, 1, 'never a new sign-in');
  assert.equal(server.renewals().length, 1);
  assert.deepEqual(Object.keys(server.renewals()[0].form).sort(), ['grant_type', 'refresh_token']);
  assert.equal(server.of('/v1/users/me/account').length, 2, 'the account again after 30 minutes');
});

test('unplugged: power 0, connector available, charging state idle, last session energy kept', async (t) => {
  const { gladys, server, advance } = await setup(t);
  server.session = unplugged();
  await advance(MINUTE);
  assert.equal(last(gladys, 'status'), 'Débranché');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.AVAILABLE);
  assert.equal(last(gladys, 'charging-state'), CHARGING_STATE.IDLE);
  assert.equal(last(gladys, 'power'), 0);
  assert.equal(last(gladys, 'session-energy'), 4.52, 'the energy of the last session stays');
  assert.equal(last(gladys, 'target-percent'), 70, 'the next session target');
  assert.equal(last(gladys, 'charge-end'), '—');
});

test('an offline charger: connector unavailable, badge unreachable, last readings kept, commands refused', async (t) => {
  const config = { ...CONFIG, allow_commands: true };
  const { gladys, server, advance } = await setup(t, { config });
  server.session = charging(Date.now(), {
    chargerStatus: { online: false },
    power: { watt: 1, amp: 1, volt: 1 },
  });
  await advance(MINUTE);
  assert.equal(last(gladys, 'status'), 'Borne hors ligne');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.UNAVAILABLE);
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  // Offline readings are not published: the last ones are kept (documented).
  assert.equal(last(gladys, 'power'), 7200);
  const ack = await gladys.fake.setValue(
    deviceOf(gladys),
    featureOf(gladys, 'charge-mode'),
    'max_charge',
  );
  assert.match(ack.error, /hors ligne/);
  assert.equal(server.commands().length, 0);
});

test('secondary reads: a 401 never stops, a 403 skips that endpoint for an hour', async (t) => {
  const { gladys, server, advance, store } = await setup(t);
  server.queue.push({
    match: (r) => r.path === '/v1/chargeSessions/nextSessionInfo',
    status: 401,
  });
  await advance(MINUTE);
  assert.equal(store.data.block, null, 'no stop');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const renewals = server.renewals().length;
  server.queue.push({
    match: (r) => r.path === '/v1/chargeSessions/nextSessionInfo',
    status: 403,
  });
  await advance(MINUTE);
  const reads = server.of('/v1/chargeSessions/nextSessionInfo').length;
  await advance(30 * MINUTE, MINUTE);
  assert.equal(server.of('/v1/chargeSessions/nextSessionInfo').length, reads, 'skipped');
  assert.equal(server.renewals().length, renewals, 'no renewal for a secondary 403');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  await advance(31 * MINUTE, MINUTE);
  assert.ok(server.of('/v1/chargeSessions/nextSessionInfo').length > reads, 'read again after 1 h');
});

test('a 403 on a command refuses that command only, a waiting approval is named', async (t) => {
  const config = { ...CONFIG, allow_commands: true, language: 'en' };
  const { gladys, server, store } = await setup(t, { config });
  server.queue.push({ match: (r) => r.method === 'PUT', status: 403 });
  let ack = await gladys.fake.setValue(
    deviceOf(gladys),
    featureOf(gladys, 'charge-mode'),
    'max_charge',
  );
  assert.match(ack.error, /refused the command.*HTTP 403/);
  assert.equal(store.data.pause, null, 'no pause for a command 403');
  server.session = charging(Date.now(), { mode: 'PENDING_APPROVAL' });
  ack = await gladys.fake.setValue(deviceOf(gladys), featureOf(gladys, 'charge-mode'), 'paused');
  assert.match(ack.error, /waiting for approval in the Ohme app/);
});

test('the target of the next session is decided on a fresh read of its rule', async (t) => {
  const config = { ...CONFIG, allow_commands: true };
  const { gladys, server } = await setup(t, { config });
  server.session = unplugged();
  server.next = { rule: { id: 'rule-next', targetPercent: 60 } };
  const reads = server.of('/v1/chargeSessions/nextSessionInfo').length;
  const ack = await gladys.fake.setValue(
    deviceOf(gladys),
    featureOf(gladys, 'set-target-percent'),
    '70',
  );
  assert.equal(ack.success, true, ack.error);
  assert.equal(server.of('/v1/chargeSessions/nextSessionInfo').length, reads + 1);
  assert.equal(server.commands().at(-1).path, '/v2/users/me/charge-rules/rule-next');
});

test('a refused password stops, is kept in /data, and is tried again only after 6 h then 24 h', async (t) => {
  const server = fakeOhme();
  server.password = 'another one';
  const store = memoryStore();
  const { gladys, advance, app } = await setup(t, { server, store });
  assert.equal(server.signIns().length, 1);
  assert.equal(server.api().length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /refused the e-mail or the password.*6 h/);
  assert.equal(store.data.block.kind, 'refused');
  await advance(5 * HOUR, MINUTE);
  assert.equal(server.signIns().length, 1, 'no sign-in before 6 h');
  // A restart keeps the stop: no sign-in.
  await app.start(CONFIG);
  await settle();
  assert.equal(server.signIns().length, 1, 'a restart never sends refused credentials again');
  await advance(HOUR, MINUTE);
  assert.equal(server.signIns().length, 2, 'one new try after 6 h');
  assert.match(message(gladys).en, /24 h/);
  await advance(23 * HOUR, 10 * MINUTE);
  assert.equal(server.signIns().length, 2);
  // New credentials lift the stop at once.
  server.password = PASSWORD;
  await gladys.fake.configUpdated({ ...CONFIG, password: PASSWORD, language: 'en' });
  await settle();
  assert.equal(server.signIns().length, 2, 'the same password: no change, no sign-in');
  await gladys.fake.configUpdated({ email: EMAIL, password: 'changed' });
  await settle();
  assert.equal(server.signIns().length, 3, 'a new password signs in at once');
  assert.equal(store.data.block?.kind, 'refused');
  server.password = 'changed';
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.equal(server.signIns().length, 4, 'the test button tries once');
  assert.match(ack.data.message.en, /Ohme Home Pro: Charging, 7200 W/);
  assert.equal(store.data.block, null);
});

test('a token refused by the API is renewed once; refused again, a spaced stop (1 h, 6 h)', async (t) => {
  const { gladys, server, advance, store } = await setup(t);
  server.revoke();
  await advance(MINUTE);
  assert.equal(server.renewals().length, 1, 'the refused token is renewed');
  assert.equal(gladys.fake.connectionStatus.connected, true, 'the renewed token works');
  // Now the API refuses every token, even fresh ones.
  server.rejectApi = true;
  await advance(MINUTE);
  assert.equal(store.data.block.kind, 'session_refused');
  assert.match(message(gladys).en, /refused the session again.*60 min/);
  const renewals = server.renewals().length;
  await advance(59 * MINUTE, MINUTE);
  assert.equal(server.renewals().length, renewals, 'nothing for an hour');
  await advance(MINUTE, MINUTE);
  assert.ok(server.renewals().length > renewals, 'one new try after 1 h');
  assert.match(message(gladys).en, /6 h/);
  assert.equal(server.signIns().length, 1, 'the refresh token works: no new sign-in');
});

test('a 429 pauses every path (Retry-After bounded), survives a restart and a Gladys reconnection', async (t) => {
  const store = memoryStore();
  const { gladys, server, advance, app } = await setup(t, { store });
  server.queue.push({
    match: (r) => r.path === '/v1/chargeSessions',
    status: 429,
    headers: { 'retry-after': '1' },
  });
  await advance(MINUTE);
  assert.equal(store.data.pause.kind, 'rate');
  assert.equal(store.data.pause.until, Date.now() + TIMINGS.rateLimitMin, 'at least 1 minute');
  assert.match(message(gladys).en, /slow down/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /slow down/, 'the button waits too');
  // Gladys restarts: the pause stays.
  const before = server.requests.length;
  await app.connected(CONFIG);
  await settle();
  assert.equal(server.requests.length, before, 'a reconnection reads nothing during the pause');
  await advance(MINUTE, 10_000);
  assert.ok(server.requests.length > before, 'read again after the pause');
});

test('a long Retry-After is bounded to 6 h, and persisted pauses are bounded at a restart', async (t) => {
  const store = memoryStore({
    pause: { kind: 'rate', until: NOW + 30 * 24 * HOUR },
  });
  const { server, advance } = await setup(t, { store });
  assert.equal(server.requests.length, 0, 'the persisted pause holds');
  await advance(24 * HOUR, 10 * MINUTE);
  assert.ok(server.requests.length > 0, 'but never more than 24 h');
});

test('a failing secondary read never hides the session; its 429 pauses after the data is shown', async (t) => {
  const server = fakeOhme();
  server.queue.push({
    match: (r) => r.path === '/v1/chargeSessions/nextSessionInfo',
    status: 500,
  });
  const { gladys, advance } = await setup(t, { server });
  assert.equal(last(gladys, 'power'), 7200);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  server.queue.push({
    match: (r) => r.path === '/v1/chargeSessions/nextSessionInfo',
    status: 429,
    headers: { 'retry-after': '600' },
  });
  server.session = charging(Date.now(), { power: { watt: 3600, amp: 16, volt: 230 } });
  await advance(MINUTE);
  assert.equal(last(gladys, 'power'), 3600, 'the session is shown');
  assert.match(message(gladys).en, /slow down: pausing for 10 min/);
  const reads = server.of('/v1/chargeSessions').length;
  await advance(9 * MINUTE, MINUTE);
  assert.equal(server.of('/v1/chargeSessions').length, reads, 'every path waits');
});

test('network errors: backoff never shorter than the interval, badge unreachable, then back', async (t) => {
  const { gladys, server, advance } = await setup(t);
  server.down = true;
  await advance(MINUTE);
  assert.match(message(gladys).en, /cannot be reached.*2 min/);
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  const tries = server.requests.length;
  await advance(MINUTE);
  assert.equal(server.requests.length, tries);
  server.down = false;
  await advance(MINUTE);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.CLOUD);
});

test('commands are refused without any request while not allowed', async (t) => {
  const { gladys, server } = await setup(t);
  const before = server.requests.length;
  const device = deviceOf(gladys);
  const ack = await gladys.fake.setValue(device, featureOf(gladys, 'charge-mode'), 'max_charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Autoriser les commandes/);
  const target = await gladys.fake.setValue(device, featureOf(gladys, 'set-target-percent'), '90');
  assert.equal(target.success, false);
  const sensor = await gladys.fake.setValue(device, featureOf(gladys, 'power'), 0);
  assert.match(sensor.error, /lecture seule/);
  assert.equal(server.requests.length, before);
});

test('allowed: max charge, pause, smart from a pause, battery target, each after a fresh read', async (t) => {
  const config = { ...CONFIG, allow_commands: true, language: 'en' };
  const { gladys, server, advance } = await setup(t, { config });
  const device = deviceOf(gladys);
  const mode = featureOf(gladys, 'charge-mode');

  let ack = await gladys.fake.setValue(device, mode, 'max_charge');
  assert.equal(ack.success, true, ack.error);
  let [command] = server.commands();
  assert.equal(command.method, 'PUT');
  assert.equal(
    command.path,
    `/v2/charge-devices/${SERIAL}/charge-sessions/active/${SERIAL}/max-charge`,
  );
  assert.equal(command.query.enabled, 'true');
  const sequence = routes(server).slice(-2);
  assert.match(sequence[0], /GET api\.ohme\.io\/v1\/chargeSessions$/, 'a fresh read first');

  ack = await gladys.fake.setValue(device, mode, 'paused');
  assert.equal(ack.success, true);
  assert.equal(server.commands().at(-1).path, `/v1/chargeSessions/${SERIAL}/stop`);

  server.session = paused();
  ack = await gladys.fake.setValue(device, mode, 'max_charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /paused: choose "Smart charge" first/);
  ack = await gladys.fake.setValue(device, mode, 'smart_charge');
  assert.equal(ack.success, true);
  assert.equal(server.commands().at(-1).path, `/v1/chargeSessions/${SERIAL}/resume`);

  server.session = charging();
  ack = await gladys.fake.setValue(device, featureOf(gladys, 'set-target-percent'), '90');
  assert.equal(ack.success, true, ack.error);
  command = server.commands().at(-1);
  assert.equal(command.method, 'PATCH');
  assert.equal(command.path, '/v2/users/me/charge-rules/rule-1');
  assert.deepEqual(command.query, { persist: 'true', recalculateSession: 'true' });
  assert.deepEqual(command.json, { targetPercent: 90 });

  const commands = server.commands().length;
  ack = await gladys.fake.setValue(device, mode, 'smart_charge');
  assert.equal(ack.success, true, 'already in smart mode');
  assert.equal(server.commands().length, commands, 'nothing sent when nothing changes');

  ack = await gladys.fake.setValue(device, featureOf(gladys, 'set-target-percent'), '42');
  assert.equal(ack.success, false, 'only the listed targets');
  ack = await gladys.fake.setValue(device, mode, 'off');
  assert.equal(ack.success, false);

  server.session = unplugged();
  ack = await gladys.fake.setValue(device, mode, 'max_charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /No vehicle is plugged in/);
  assert.equal(server.commands().length, commands);

  // The effect is read 10 s after a command.
  const reads = server.of('/v1/chargeSessions').length;
  server.session = charging();
  await gladys.fake.setValue(device, mode, 'max_charge');
  await advance(10_000, 10_000);
  assert.equal(server.of('/v1/chargeSessions').length, reads + 2);
});

test('a command answered late: Gladys is acked within its 5 s, the request finishes in the background', async (t) => {
  const config = { ...CONFIG, allow_commands: true };
  const { gladys, server, advance, logs } = await setup(t, { config });
  let release;
  server.queue.push({
    match: (r) => r.method === 'PUT',
    status: 200,
    wait: new Promise((resolve) => {
      release = resolve;
    }),
  });
  const pending = gladys.fake.setValue(
    deviceOf(gladys),
    featureOf(gladys, 'charge-mode'),
    'max_charge',
  );
  await settle();
  await advance(TIMINGS.commandAck, 100);
  const ack = await pending;
  assert.equal(ack.success, true);
  const busy = await gladys.fake.setValue(
    deviceOf(gladys),
    featureOf(gladys, 'charge-mode'),
    'paused',
  );
  assert.match(busy.error, /encore en cours/, 'one command at a time');
  release();
  await settle();
  assert.ok(logs.some((l) => /command charge-mode done/.test(l)));
});

test('a command never leaves after 3.5 s: a slow fresh read refuses it unsent', async (t) => {
  const config = { ...CONFIG, allow_commands: true };
  const { gladys, server, advance } = await setup(t, { config });
  let release;
  server.queue.push({
    match: (r) => r.path === '/v1/chargeSessions',
    status: 200,
    body: [charging()],
    wait: new Promise((resolve) => {
      release = resolve;
    }),
  });
  const pending = gladys.fake.setValue(
    deviceOf(gladys),
    featureOf(gladys, 'charge-mode'),
    'max_charge',
  );
  await settle();
  await advance(3_000, 100);
  release();
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /pas été envoyée/);
  assert.equal(server.commands().length, 0);
});

test('a 429 on a command pauses every path', async (t) => {
  const config = { ...CONFIG, allow_commands: true };
  const { gladys, server, store } = await setup(t, { config });
  server.queue.push({
    match: (r) => r.method === 'PUT',
    status: 429,
    headers: { 'retry-after': '300' },
  });
  const ack = await gladys.fake.setValue(
    deviceOf(gladys),
    featureOf(gladys, 'charge-mode'),
    'max_charge',
  );
  assert.equal(ack.success, false);
  assert.match(ack.error, /ralentir/);
  assert.equal(store.data.pause.kind, 'rate');
  const next = await gladys.fake.setValue(
    deviceOf(gladys),
    featureOf(gladys, 'charge-mode'),
    'paused',
  );
  assert.match(next.error, /ralentir/);
  assert.equal(server.commands().length, 1);
});

test('a Gladys reconnection republishes the device, the status and the states', async (t) => {
  const { gladys, app } = await setup(t);
  const published = () => gladys.fake.bodies('POST', '/discovered_device').length;
  const devices = published();
  const states = gladys.fake.states.length;
  await app.connected(CONFIG);
  await settle();
  assert.equal(published(), devices + 1);
  assert.ok(gladys.fake.states.length >= states);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('an account without a charger says so and retries later', async (t) => {
  const server = fakeOhme();
  server.account = { ...server.account, chargeDevices: [] };
  const { gladys } = await setup(t, { server });
  assert.match(message(gladys).en, /no charger/);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
});
