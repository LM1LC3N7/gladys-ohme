// -----------------------------------------------------------------------------
// A fake Firebase and a fake Ohme API behind the transport the integration is
// given, answering like ohmepy expects (idToken/refreshToken from
// verifyPassword, id_token/refresh_token from securetoken, `Authorization:
// Firebase <token>` on the API). Records every request. No network.
// -----------------------------------------------------------------------------

import { FIREBASE_API_KEY } from '../../src/constants.js';
import { OhmeError } from '../../src/ohme.js';
import {
  EMAIL,
  PASSWORD,
  SERIAL,
  USER_ID,
  account,
  charging,
  jwt,
  nextRule,
} from '../fixtures/ohme.js';

const answer = (status, body, headers = {}) => ({
  status,
  headers,
  body: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
});

export function fakeOhme({ session = charging() } = {}) {
  const server = {
    email: EMAIL,
    password: PASSWORD,
    account: account(),
    session,
    next: nextRule(),
    /** { method, host, path, query, form, json, token, headers } */
    requests: [],
    idTokens: new Set(),
    refreshTokens: new Set(),
    /** Every secret ever issued, to check none reaches the logs. */
    secrets: [],
    issued: 0,
    down: false,
    /** The API refuses every token, even fresh ones. */
    rejectApi: false,
    /** One-shot answers: { match(request), status, body, headers, wait } */
    queue: [],
    of(path) {
      return this.requests.filter((r) => r.path === path);
    },
    signIns() {
      return this.requests.filter((r) => r.path.endsWith('/verifyPassword'));
    },
    renewals() {
      return this.requests.filter((r) => r.host === 'securetoken.googleapis.com');
    },
    api() {
      return this.requests.filter((r) => r.host === 'api.ohme.io');
    },
    commands() {
      return this.api().filter((r) => r.method !== 'GET');
    },
    issue() {
      this.issued += 1;
      const idToken = jwt({ user_id: USER_ID, n: this.issued });
      const refreshToken = `refresh-${this.issued}-secret`;
      this.idTokens.add(idToken);
      this.refreshTokens.add(refreshToken);
      this.secrets.push(idToken, refreshToken);
      return { idToken, refreshToken };
    },
    /** The API refuses every id token issued so far (the refresh tokens still work). */
    revoke() {
      this.idTokens.clear();
    },
    revokeAll() {
      this.idTokens.clear();
      this.refreshTokens.clear();
    },
  };

  server.transport = async (url, { method = 'GET', headers = {}, body, onSent } = {}) => {
    const target = new URL(url);
    const request = {
      method,
      host: target.host,
      path: target.pathname,
      query: Object.fromEntries(target.searchParams),
      headers,
      form:
        headers['Content-Type'] === 'application/x-www-form-urlencoded'
          ? Object.fromEntries(new URLSearchParams(body))
          : undefined,
      json: headers['Content-Type'] === 'application/json' && body ? JSON.parse(body) : undefined,
      token: String(headers.Authorization ?? '').replace(/^Firebase /, '') || undefined,
    };
    server.requests.push(request);
    if (server.down) {
      throw new OhmeError('network', 'connection refused', { notSent: true });
    }
    onSent?.();
    const forced = server.queue.findIndex((q) => q.match(request));
    if (forced >= 0) {
      const [entry] = server.queue.splice(forced, 1);
      if (entry.wait) {
        await entry.wait;
      }
      if (entry.error) {
        throw entry.error;
      }
      return answer(entry.status, entry.body, entry.headers);
    }

    if (request.host === 'www.googleapis.com') {
      if (request.query.key !== FIREBASE_API_KEY) {
        return answer(400, { error: { code: 400, message: 'API key not valid' } });
      }
      const { email, password, returnSecureToken } = request.form ?? {};
      if (email !== server.email || password !== server.password || returnSecureToken !== 'true') {
        return answer(400, {
          error: { code: 400, message: 'INVALID_LOGIN_CREDENTIALS', errors: [] },
        });
      }
      const { idToken, refreshToken } = server.issue();
      return answer(200, {
        kind: 'identitytoolkit#VerifyPasswordResponse',
        localId: USER_ID,
        email,
        idToken,
        refreshToken,
        expiresIn: '3600',
      });
    }
    if (request.host === 'securetoken.googleapis.com') {
      const { grant_type: grant, refresh_token: token } = request.form ?? {};
      if (grant !== 'refresh_token' || !server.refreshTokens.has(token)) {
        return answer(400, { error: { code: 400, message: 'INVALID_REFRESH_TOKEN' } });
      }
      server.refreshTokens.delete(token);
      const { idToken, refreshToken } = server.issue();
      return answer(200, {
        id_token: idToken,
        refresh_token: refreshToken,
        expires_in: '3600',
        user_id: USER_ID,
        token_type: 'Bearer',
      });
    }

    if (!server.idTokens.has(request.token) || server.rejectApi) {
      return answer(401, { message: 'Unauthorized' });
    }
    const route = `${method} ${request.path}`;
    switch (route) {
      case 'GET /v1/users/me/account':
        return answer(200, server.account);
      case 'GET /v1/chargeSessions':
        return answer(200, [server.session]);
      case 'GET /v1/chargeSessions/nextSessionInfo':
        return answer(200, server.next);
      case `POST /v1/chargeSessions/${SERIAL}/stop`:
      case `POST /v1/chargeSessions/${SERIAL}/resume`:
        return answer(200, 'OK');
      case `PUT /v2/charge-devices/${SERIAL}/charge-sessions/active/${SERIAL}/max-charge`:
      case 'PATCH /v2/users/me/charge-rules/rule-1':
      case 'PATCH /v2/users/me/charge-rules/rule-next':
        return answer(200, '');
      default:
        return answer(404, { message: 'Not found' });
    }
  };

  return server;
}

/** An in-memory store, in place of the /data file. */
export function memoryStore(initial = null) {
  return {
    data: initial,
    saves: 0,
    async load() {
      return this.data === null ? null : structuredClone(this.data);
    },
    async save(data) {
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

/** Lets the pending promises settle (no timer involved). */
export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
