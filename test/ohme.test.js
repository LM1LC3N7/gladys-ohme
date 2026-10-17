// -----------------------------------------------------------------------------
// The network layer: error mapping (never any free text of the answer), and
// the real transport against a loopback server (bounded body, timeout).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  OhmeError,
  apiError,
  errorReason,
  firebaseCode,
  firebaseError,
  httpRequest,
  parseRetryAfter,
  tokenUserId,
} from '../src/ohme.js';
import { jwt } from './fixtures/ohme.js';

test('Firebase errors: refusal, rejection, renewal refused, too many attempts', () => {
  const login = (status, message) =>
    firebaseError({ status }, { error: { message } }, { step: 'login', now: 0 });
  assert.equal(login(400, 'INVALID_LOGIN_CREDENTIALS').kind, 'refused');
  assert.equal(login(400, 'INVALID_PASSWORD').kind, 'refused');
  assert.equal(login(400, 'USER_DISABLED').kind, 'refused');
  assert.equal(
    login(400, 'API key not valid. Please pass a valid API key.').kind,
    'login_rejected',
  );
  assert.equal(login(403, undefined).kind, 'login_rejected');
  const many = login(400, 'TOO_MANY_ATTEMPTS_TRY_LATER : Access to this account has been disabled');
  assert.equal(many.kind, 'rate_limited');
  assert.equal(many.retryAfter, 60 * 60_000);
  assert.ok(!errorReason(many).includes('Access'), 'never the free text');
  assert.equal(login(503).kind, 'unavailable');
  assert.equal(login(200), undefined);
  assert.equal(
    firebaseError({ status: 400 }, { error: { message: 'TOKEN_EXPIRED' } }, { step: 'refresh' })
      .kind,
    'refresh_refused',
  );
  assert.equal(firebaseCode({ error: { message: 'lower case text' } }), undefined);
});

test('API errors and Retry-After', () => {
  assert.equal(apiError({ status: 401 }).kind, 'unauthorized');
  assert.equal(apiError({ status: 403 }).kind, 'forbidden');
  const limited = apiError({ status: 429, headers: { 'retry-after': '120' } }, { now: 0 });
  assert.equal(limited.kind, 'rate_limited');
  assert.equal(limited.retryAfter, 120_000);
  assert.equal(apiError({ status: 502 }).kind, 'unavailable');
  assert.equal(apiError({ status: 404 }).kind, 'http');
  assert.equal(apiError({ status: 204 }), undefined);
  assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:01:00 GMT', 0), 60_000);
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(errorReason(new Error('secret token abc')), 'internal error');
  assert.equal(tokenUserId(jwt({ user_id: 'u-1' })), 'u-1');
  assert.equal(tokenUserId('nope'), undefined);
});

async function server(handler) {
  const srv = createServer(handler);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

test('the transport: answers, a bounded body, a timeout', async (t) => {
  const s = await server((req, res) => {
    if (req.url === '/big') {
      res.end('x'.repeat(2000));
    } else if (req.url === '/slow') {
      setTimeout(() => res.end('late'), 500);
    } else {
      res.writeHead(201, { 'retry-after': '5' });
      res.end('{"ok":true}');
    }
  });
  t.after(() => s.close());
  let sent = false;
  const ok = await httpRequest(`${s.url}/`, { onSent: () => (sent = true) });
  assert.equal(ok.status, 201);
  assert.equal(ok.body, '{"ok":true}');
  assert.ok(sent);
  await assert.rejects(
    httpRequest(`${s.url}/big`, { maxBytes: 100 }),
    (err) => err.kind === 'size',
  );
  await assert.rejects(
    httpRequest(`${s.url}/slow`, { timeout: 50 }),
    (err) => err instanceof OhmeError && err.kind === 'timeout' && !err.notSent,
  );
  await assert.rejects(
    httpRequest('http://127.0.0.1:1/', { timeout: 2000 }),
    (err) => err.kind === 'network' && err.notSent,
  );
});
