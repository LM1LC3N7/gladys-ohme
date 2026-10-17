// -----------------------------------------------------------------------------
// The only network access: HTTPS requests to Firebase (sign-in, token renewal)
// and to the Ohme API, and the errors they end with. Pure helpers for the
// answers.
//
// ohmepy (MIT) is the reference: the e-mail and the password go to Firebase's
// `verifyPassword`, which answers an `idToken` and a `refreshToken`; the API is
// called with `Authorization: Firebase <idToken>`; the token is renewed from
// the refresh token on `securetoken.googleapis.com`.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { LIMITS, TIMINGS } from './constants.js';

/**
 * A failed call. `kind`:
 * - `no_credentials`: no e-mail or password (never sent);
 * - `refused`: Firebase refused the e-mail or the password;
 * - `login_rejected`: the sign-in request itself was rejected (another 4xx:
 *   the API key or the protocol changed, the integration needs an update);
 * - `refresh_refused`: the refresh token was refused (expired, revoked);
 * - `unauthorized`: the API refused the token (401);
 * - `forbidden`: a 403 of the API;
 * - `session_refused`: the token was refused again right after a renewal;
 * - `rate_limited`: 429 (or TOO_MANY_ATTEMPTS_TRY_LATER), `retryAfter` in ms;
 * - `unavailable`: 5xx;
 * - `network`, `timeout`: no answer; `notSent` tells the request never left;
 * - `bad_response`, `size`: an answer that is not the expected JSON;
 * - `http`: any other status.
 * The message never holds a secret nor any free text of the answer: only a
 * short upper-case code when the answer has one.
 */
export class OhmeError extends Error {
  constructor(kind, message, { status, retryAfter, code, notSent } = {}) {
    super(message);
    this.name = 'OhmeError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    this.code = code;
    this.notSent = Boolean(notSent);
  }
}

const NETWORK_REASONS = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

/** A socket error -> OhmeError (never the request: the sign-in carries the password). */
export function networkError(err, notSent = false) {
  if (err instanceof OhmeError) {
    return err;
  }
  const code = typeof err?.code === 'string' && /^[A-Z_]{1,32}$/.test(err.code) ? err.code : '';
  return new OhmeError('network', NETWORK_REASONS[code] ?? (code || 'network error'), {
    notSent,
  });
}

/** A short, secret-free reason for a log or a status message. */
export function errorReason(err) {
  if (err instanceof OhmeError) {
    const details = [err.code, err.status ? `HTTP ${err.status}` : undefined].filter(Boolean);
    return details.length > 0 ? `${err.message} (${details.join(', ')})` : err.message;
  }
  return 'internal error';
}

/**
 * One request; resolves `{ status, headers, body }` whatever the status. The
 * promise settles once; the body read is bounded. `onSent` is called once the
 * request has fully left (a command must know whether it was sent).
 */
export function httpRequest(
  url,
  {
    method = 'GET',
    headers = {},
    body,
    timeout = TIMINGS.requestTimeout,
    maxBytes = LIMITS.responseBytes,
    onSent,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    let timer;
    let settled = false;
    let sent = false;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const req = lib.request(target, { method, headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          settle(reject, new OhmeError('size', 'answer too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        settle(resolve, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (err) => settle(reject, networkError(err)));
    });
    req.on('finish', () => {
      sent = true;
      onSent?.();
    });
    timer = setTimeout(() => {
      settle(
        reject,
        new OhmeError('timeout', `no answer within ${Math.round(timeout / 1000)} s`, {
          notSent: !sent,
        }),
      );
      req.destroy();
    }, timeout);
    req.on('error', (err) => settle(reject, networkError(err, !sent)));
    req.end(body);
  });
}

/** Retry-After (seconds or an HTTP date) -> milliseconds, undefined when absent. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The JSON of a body; `undefined` for an empty body. */
export function parseJson(body) {
  if (body === undefined || body === null || String(body).trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new OhmeError('bad_response', 'an answer that is not JSON');
  }
}

/**
 * The code of a Firebase error (`{ error: { message: "INVALID_PASSWORD" } }`,
 * sometimes `"TOO_MANY_ATTEMPTS_TRY_LATER : <free text>"`): the upper-case
 * code only, never the free text.
 */
export function firebaseCode(json) {
  const message = json && typeof json === 'object' ? json.error?.message : undefined;
  if (typeof message !== 'string') {
    return undefined;
  }
  const code = message.split(/[\s:]/, 1)[0];
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : undefined;
}

/** Firebase answers meaning "this e-mail and password do not sign in". */
export const REFUSED_CODES = new Set([
  'EMAIL_NOT_FOUND',
  'INVALID_PASSWORD',
  'INVALID_LOGIN_CREDENTIALS',
  'INVALID_EMAIL',
  'USER_DISABLED',
  'MISSING_PASSWORD',
  'MISSING_EMAIL',
  'PASSWORD_LOGIN_DISABLED',
]);

const rateLimited = (status, retryAfter) =>
  new OhmeError('rate_limited', 'too many requests', { status, retryAfter });

/**
 * The error of a Firebase answer (`step`: 'login' or 'refresh'), or
 * undefined when it is a success.
 */
export function firebaseError({ status, headers = {} }, json, { step, now } = {}) {
  if (status >= 200 && status < 300) {
    return undefined;
  }
  const code = firebaseCode(json);
  if (status === 429) {
    return rateLimited(status, parseRetryAfter(headers['retry-after'], now));
  }
  if (code === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
    return new OhmeError('rate_limited', 'too many sign-in attempts', {
      status,
      code,
      retryAfter: TIMINGS.tooManyAttempts,
    });
  }
  if (status >= 500) {
    return new OhmeError('unavailable', 'the sign-in service is unavailable', { status });
  }
  if (step === 'refresh') {
    return new OhmeError('refresh_refused', 'token renewal refused', { status, code });
  }
  if (REFUSED_CODES.has(code)) {
    return new OhmeError('refused', 'e-mail or password refused', { status, code });
  }
  return new OhmeError('login_rejected', 'sign-in request rejected', { status, code });
}

/** The error of an Ohme API answer, or undefined when it is a success. */
export function apiError({ status, headers = {} }, { now } = {}) {
  if (status >= 200 && status < 300) {
    return undefined;
  }
  if (status === 401) {
    return new OhmeError('unauthorized', 'token refused', { status });
  }
  if (status === 403) {
    return new OhmeError('forbidden', 'request refused', { status });
  }
  if (status === 429) {
    return rateLimited(status, parseRetryAfter(headers['retry-after'], now));
  }
  if (status >= 500) {
    return new OhmeError('unavailable', 'Ohme is unavailable', { status });
  }
  return new OhmeError('http', 'request failed', { status });
}

/** The `user_id` claim of a Firebase JWT (ohmepy reads it the same way), or undefined. */
export function tokenUserId(token) {
  const payload = String(token ?? '').split('.')[1];
  if (!payload) {
    return undefined;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const value = claims?.user_id;
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
