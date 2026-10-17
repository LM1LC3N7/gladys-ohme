// -----------------------------------------------------------------------------
// The Ohme account: the Firebase sign-in (e-mail and password), the token
// renewed from the refresh token before it expires (never a new sign-in per
// cycle), and the calls the integration makes. Every request goes through the
// transport of src/ohme.js. Ported from ohmepy (MIT).
// -----------------------------------------------------------------------------

import { FIREBASE_API_KEY, PATHS, TIMINGS, URLS, USER_AGENT } from './constants.js';
import { OhmeError, apiError, firebaseError, httpRequest, parseJson, tokenUserId } from './ohme.js';

const FORM = 'application/x-www-form-urlencoded';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A Firebase token answer -> the session kept (and persisted). */
export function sessionOf({ idToken, refreshToken, expiresIn, userId }, now) {
  if (typeof idToken !== 'string' || idToken === '' || typeof refreshToken !== 'string') {
    throw new OhmeError('bad_response', 'the sign-in service sent no token');
  }
  const seconds = Number(expiresIn);
  const lifetime = Number.isFinite(seconds) && seconds > 60 ? seconds * 1000 : 3600_000;
  const expiresAt = now + lifetime;
  return {
    idToken,
    refreshToken,
    expiresAt,
    renewAt: Math.min(now + TIMINGS.tokenRenewAge, expiresAt - TIMINGS.tokenRenewMargin),
    userId: tokenUserId(idToken) ?? (typeof userId === 'string' ? userId.slice(0, 128) : undefined),
  };
}

export class OhmeClient {
  constructor({ transport = httpRequest, now = Date.now, onChange } = {}) {
    this.transport = transport;
    this.now = now;
    /** Called after the session changed (persist it; never throws). */
    this.onChange = onChange;
    this.email = '';
    this.password = '';
    /** { idToken, refreshToken, expiresAt, renewAt, userId } | null */
    this.session = null;
    /** One sign-in or renewal at a time. */
    this.authenticating = undefined;
    /** One new sign-in per cycle at most (beginCycle resets it). */
    this.relogged = false;
    /** Per-request timeout; undefined = the transport's default (shorter for the test button). */
    this.timeout = undefined;
  }

  configure({ email, password, session = null }) {
    this.email = email;
    this.password = password;
    this.session =
      session && typeof session.idToken === 'string' && typeof session.refreshToken === 'string'
        ? session
        : null;
    this.relogged = false;
  }

  get hasCredentials() {
    return this.email !== '' && this.password !== '';
  }

  beginCycle() {
    this.relogged = false;
  }

  async changed() {
    try {
      await this.onChange?.();
    } catch {
      // Persisting is best effort: the session still works in memory.
    }
  }

  /** The timeout of a request that must be answered before `deadline` (if any). */
  timeoutFor(deadline) {
    const base = this.timeout ?? TIMINGS.requestTimeout;
    if (deadline === undefined) {
      return base;
    }
    const left = deadline - this.now();
    if (left < 300) {
      throw new OhmeError('timeout', 'no time left to send the request', { notSent: true });
    }
    return Math.min(base, left);
  }

  async firebase(url, form, step, deadline) {
    const body = new URLSearchParams(form).toString();
    const answer = await this.transport(`${url}?key=${FIREBASE_API_KEY}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': FORM,
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': USER_AGENT,
      },
      body,
      timeout: this.timeoutFor(deadline),
    });
    let json;
    try {
      json = parseJson(answer.body);
    } catch (err) {
      if (answer.status >= 200 && answer.status < 300) {
        throw err;
      }
    }
    const error = firebaseError(answer, json, { step, now: this.now() });
    if (error) {
      throw error;
    }
    if (!isObject(json)) {
      throw new OhmeError('bad_response', 'the sign-in service sent no token');
    }
    return json;
  }

  /** One sign-in or renewal at a time: a second caller joins the running one. */
  authenticate(fn) {
    if (!this.authenticating) {
      this.authenticating = fn().finally(() => {
        this.authenticating = undefined;
      });
    }
    return this.authenticating;
  }

  /** Signs in with the e-mail and the password (ohmepy's async_login). */
  signIn({ deadline } = {}) {
    return this.authenticate(() => this.signInNow(deadline));
  }

  /** The sign-in itself; only ever run inside authenticate(). */
  async signInNow(deadline) {
    if (!this.hasCredentials) {
      throw new OhmeError('no_credentials', 'no e-mail or password');
    }
    {
      const { email } = this;
      const json = await this.firebase(
        URLS.signIn,
        { email, password: this.password, returnSecureToken: 'true' },
        'login',
        deadline,
      );
      if (this.email !== email) {
        throw new OhmeError('network', 'the account changed during the sign-in');
      }
      this.session = sessionOf(
        {
          idToken: json.idToken,
          refreshToken: json.refreshToken,
          expiresIn: json.expiresIn,
          userId: json.localId,
        },
        this.now(),
      );
      await this.changed();
      return this.session;
    }
  }

  /** Renews the token from the refresh token (ohmepy's _async_refresh_session). */
  renew({ deadline } = {}) {
    return this.authenticate(() => this.renewNow(deadline));
  }

  /** The renewal itself; only ever run inside authenticate(). */
  async renewNow(deadline) {
    const refreshToken = this.session?.refreshToken;
    {
      const json = await this.firebase(
        URLS.refresh,
        { grant_type: 'refresh_token', refresh_token: refreshToken },
        'refresh',
        deadline,
      );
      this.session = sessionOf(
        {
          idToken: json.id_token,
          refreshToken: json.refresh_token,
          expiresIn: json.expires_in,
          userId: json.user_id,
        },
        this.now(),
      );
      await this.changed();
      return this.session;
    }
  }

  /**
   * A usable token: a sign-in when there is no session (one per cycle), a
   * renewal when it is due. A refused refresh token drops the session and
   * signs in once. Resolves true when the token is a new one.
   *
   * The renewal and its fallback sign-in run as ONE authenticate() step, so
   * two callers (the polling and a command) never race on the session: the
   * second one joins the step and gets its outcome, its real error included
   * (a refused password stays `refused`, never becomes `session_refused`).
   */
  async ensureToken({ deadline } = {}) {
    if (this.authenticating) {
      await this.authenticating;
      if (this.session && this.now() < this.session.renewAt) {
        return true;
      }
    }
    if (this.session && this.now() < this.session.renewAt) {
      return false;
    }
    await this.authenticate(() => this.renewOrSignIn(deadline));
    return true;
  }

  async renewOrSignIn(deadline) {
    if (this.session) {
      try {
        return await this.renewNow(deadline);
      } catch (err) {
        if (err.kind !== 'refresh_refused') {
          throw err;
        }
        this.session = null;
        await this.changed();
      }
    }
    if (this.relogged) {
      throw new OhmeError('session_refused', 'the session was refused after a new sign-in');
    }
    this.relogged = true;
    return this.signInNow(deadline);
  }

  /** One API request with the current token; resolves the parsed JSON (or undefined). */
  async request(method, path, { payload, deadline, onSent } = {}) {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const headers = {
      Accept: 'application/json',
      Authorization: `Firebase ${this.session.idToken}`,
      'User-Agent': USER_AGENT,
    };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = body === undefined ? 0 : Buffer.byteLength(body);
    }
    const answer = await this.transport(`${URLS.api}${path}`, {
      method,
      headers,
      body,
      timeout: this.timeoutFor(deadline),
      onSent,
    });
    const error = apiError(answer, { now: this.now() });
    if (error) {
      throw error;
    }
    // Commands may answer plain text (ohmepy reads it as text): only reads need JSON.
    return method === 'GET' ? parseJson(answer.body) : undefined;
  }

  /** Forces a renewal at the next call (the API refused the token). */
  expire() {
    if (this.session) {
      this.session = { ...this.session, renewAt: 0 };
    }
  }

  /**
   * An authenticated read. A refused token (401, or a 403 that may be one)
   * renews once and retries once; refused again, it is `session_refused`
   * (401) or `forbidden` (403) and the caller stops or pauses.
   *
   * `secondary: true` (the reads after the main one): no sign-in, no
   * renewal, no new try; a 401/403 comes back as is (`unauthorized`,
   * `forbidden`), never as a stop.
   */
  async read(path, { secondary = false, ...options } = {}) {
    if (secondary) {
      if (!this.session || this.now() >= this.session.expiresAt) {
        throw new OhmeError('unauthorized', 'no valid token for a secondary read', {
          notSent: true,
        });
      }
      return this.request('GET', path, options);
    }
    const fresh = await this.ensureToken(options);
    try {
      return await this.request('GET', path, options);
    } catch (err) {
      if (err.kind !== 'unauthorized' && err.kind !== 'forbidden') {
        throw err;
      }
      if (fresh) {
        throw this.refusedAgain(err);
      }
    }
    this.expire();
    await this.ensureToken(options);
    try {
      return await this.request('GET', path, options);
    } catch (err) {
      throw err.kind === 'unauthorized' || err.kind === 'forbidden' ? this.refusedAgain(err) : err;
    }
  }

  refusedAgain(err) {
    if (err.kind === 'forbidden') {
      return err;
    }
    this.expire();
    return new OhmeError('session_refused', 'the token was refused right after a renewal', {
      status: err.status,
    });
  }

  /**
   * A command: sent once, never retried (a retry could act twice), and never
   * sent after `sendBy` (it is refused unsent instead); its answer may come
   * later (the usual timeout). A refused token (401 or 403) only forces one
   * renewal at the next call.
   */
  async command(method, path, { payload, sendBy, onSent } = {}) {
    await this.ensureToken({ deadline: sendBy });
    if (sendBy !== undefined && sendBy - this.now() < 300) {
      throw new OhmeError('timeout', 'no time left to send the command', { notSent: true });
    }
    try {
      await this.request(method, path, { payload, onSent });
    } catch (err) {
      if (err.kind === 'unauthorized' || err.kind === 'forbidden') {
        this.expire();
      }
      throw err;
    }
  }

  /** The account: its chargers (the first one is used, as ohmepy) and its cars. */
  async account(options) {
    const data = await this.read(PATHS.account, options);
    if (!isObject(data)) {
      throw new OhmeError('bad_response', 'Ohme sent no account');
    }
    return data;
  }

  /** The current charge session of the first charger (ohmepy reads `[0]` too). */
  async chargeSession(options) {
    const data = await this.read(PATHS.sessions, options);
    if (!Array.isArray(data) || !isObject(data[0])) {
      throw new OhmeError('bad_response', 'Ohme sent no charge session');
    }
    return data[0];
  }

  /** The rule of the next session (target percentage when nothing is plugged in). */
  async nextSession(options) {
    const data = await this.read(PATHS.nextSession, options);
    return isObject(data) && isObject(data.rule) ? data.rule : {};
  }
}
