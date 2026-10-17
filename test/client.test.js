// -----------------------------------------------------------------------------
// The token shared by two callers at once (the polling and a command).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OhmeClient } from '../src/client.js';
import { EMAIL, PASSWORD } from './fixtures/ohme.js';
import { fakeOhme, settle } from './helpers/fakeOhme.js';

/** A client whose session must be renewed, with a refresh token the server refuses. */
function dueClient(server) {
  let writes = 0;
  const client = new OhmeClient({
    transport: server.transport,
    // The /data write takes a turn of the event loop, as the real one does.
    onChange: async () => {
      writes += 1;
      await settle(2);
    },
  });
  client.configure({
    email: EMAIL,
    password: PASSWORD,
    session: { idToken: 'old', refreshToken: 'refused', expiresAt: 0, renewAt: 0 },
  });
  client.beginCycle();
  return { client, writes: () => writes };
}

test('two callers on a refused refresh token: one sign-in, no stop', async () => {
  const server = fakeOhme();
  const { client } = dueClient(server);
  const results = await Promise.allSettled([client.ensureToken(), client.ensureToken()]);
  assert.deepEqual(
    results.map((r) => r.status),
    ['fulfilled', 'fulfilled'],
    results.map((r) => r.reason?.kind).join(),
  );
  assert.equal(server.renewals().length, 1);
  assert.equal(server.signIns().length, 1);
  assert.ok(client.session?.idToken && client.session.idToken !== 'old');
});

test('a joined sign-in that is refused gives its real error to both callers', async () => {
  const server = fakeOhme();
  server.password = 'other';
  const { client } = dueClient(server);
  const results = await Promise.allSettled([client.ensureToken(), client.ensureToken()]);
  assert.deepEqual(
    results.map((r) => r.reason?.kind),
    ['refused', 'refused'],
  );
  assert.equal(server.signIns().length, 1);
});
