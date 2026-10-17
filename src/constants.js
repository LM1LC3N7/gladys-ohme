// -----------------------------------------------------------------------------
// Ohme cloud constants, manifest keys, limits and timings.
//
// The API is the one of the Ohme app, undocumented. The Firebase sign-in, the
// hosts, the paths and the `Authorization: Firebase <token>` header are those
// of ohmepy (MIT, dan-r/ohmepy); the sensors, the modes and the target
// percentage follow the Ohme integration of Home Assistant (Apache-2.0).
// -----------------------------------------------------------------------------

/**
 * The public Firebase web API key of the Ohme app, as ohmepy sends it. It
 * identifies the app, not the user: it is no secret.
 */
export const FIREBASE_API_KEY = 'AIzaSyC8ZeZngm33tpOXLpbXeKfwtyZ1WrkbdBY';

export const URLS = {
  signIn: 'https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword',
  refresh: 'https://securetoken.googleapis.com/v1/token',
  api: 'https://api.ohme.io',
};

const id = (value) => encodeURIComponent(value);

/** API paths, relative to URLS.api. */
export const PATHS = {
  account: '/v1/users/me/account',
  sessions: '/v1/chargeSessions',
  nextSession: '/v1/chargeSessions/nextSessionInfo',
  stop: (serial) => `/v1/chargeSessions/${id(serial)}/stop`,
  resume: (serial) => `/v1/chargeSessions/${id(serial)}/resume`,
  maxCharge: (serial, enabled) =>
    `/v2/charge-devices/${id(serial)}/charge-sessions/active/${id(serial)}/max-charge?enabled=${enabled ? 'true' : 'false'}`,
  chargeRule: (ruleId) =>
    `/v2/users/me/charge-rules/${id(ruleId)}?persist=true&recalculateSession=true`,
};

/** An honest User-Agent (ohmepy sends its own name and version). */
export const USER_AGENT = 'gladys-ohme/0.1 (+https://github.com/LM1LC3N7/gladys-ohme)';

/** The `mode` of a charge session, as the API sends it. */
export const API_MODES = {
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  DISCONNECTED: 'DISCONNECTED',
  STOPPED: 'STOPPED',
  FINISHED_CHARGE: 'FINISHED_CHARGE',
  SMART_CHARGE: 'SMART_CHARGE',
  MAX_CHARGE: 'MAX_CHARGE',
  /** Transient modes ohmepy reads again (the schedule is being computed). */
  CALCULATING: 'CALCULATING',
  DELIVERING: 'DELIVERING',
};

/** Statuses of ohmepy's ChargerStatus, plus `offline` (chargerStatus.online false). */
export const STATUS = {
  UNPLUGGED: 'unplugged',
  PENDING_APPROVAL: 'pending_approval',
  CHARGING: 'charging',
  PLUGGED_IN: 'plugged_in',
  PAUSED: 'paused',
  FINISHED: 'finished',
  OFFLINE: 'offline',
};

/** Charge modes of the mode select (ohmepy's ChargerMode values). */
export const MODES = {
  SMART_CHARGE: 'smart_charge',
  MAX_CHARGE: 'max_charge',
  PAUSED: 'paused',
};

/** The target percentages the target select offers (10 % to 100 %, every 5 %). */
export const TARGET_OPTIONS = Array.from({ length: 19 }, (_, i) => 10 + i * 5);

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  STATUS: 'status',
  CONNECTOR: 'connector-status',
  CHARGING_STATE: 'charging-state',
  POWER: 'power',
  CURRENT: 'current',
  VOLTAGE: 'voltage',
  SESSION_ENERGY: 'session-energy',
  VEHICLE_BATTERY: 'vehicle-battery',
  TARGET: 'target-percent',
  CHARGE_END: 'charge-end',
  MODE: 'charge-mode',
  SET_TARGET: 'set-target-percent',
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** Largest answer read: an account with its cars is a few KB. */
  responseBytes: 1024 * 1024,
  /** Longest text kept from an answer (model names, modes). */
  textLength: 60,
};

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  requestTimeout: 15_000,
  /** The test button (60 s for Gladys): shorter requests, the worst case stays under 50 s. */
  quickTimeout: 8_000,
  /** A read every minute while charging (or while Ohme computes the schedule), 5 minutes otherwise. */
  chargingInterval: MINUTE,
  idleInterval: 5 * MINUTE,
  /** The account (model, firmware, serial) is read again every 30 minutes, as Home Assistant. */
  accountInterval: 30 * MINUTE,
  /** The Firebase token is renewed after 45 minutes (ohmepy), or 5 minutes before it expires. */
  tokenRenewAge: 45 * MINUTE,
  tokenRenewMargin: 5 * MINUTE,
  /** Pauses after a failed read: 2, 5, 10, 15, then 30 minutes (never less than the interval). */
  backoff: [2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE],
  /** 429: Retry-After bounded to 1 minute .. 6 hours, 15 minutes without it. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 15 * MINUTE,
  /** Firebase TOO_MANY_ATTEMPTS_TRY_LATER: one hour. */
  tooManyAttempts: HOUR,
  /** A 403 of the main read that a new token does not cure: one hour, every path. */
  forbiddenPause: HOUR,
  /** A 403 of a secondary read: that endpoint only is skipped for an hour. */
  secondaryForbiddenSkip: HOUR,
  /** The test button (60 s for Gladys): one deadline for the whole run. */
  quickBudget: 50_000,
  /** A token refused right after a renewal: one new try after 1 h, 6 h, then every 24 h. */
  sessionRetry: [HOUR, 6 * HOUR, 24 * HOUR],
  /** A refused e-mail/password or a rejected sign-in: one new try after 6 h, then every 24 h. */
  refusedRetry: [6 * HOUR, 24 * HOUR],
  /** Longest a persisted pause or stop may still hold at a restart. */
  persistedMax: 24 * HOUR,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: 1_000,
  stateHeartbeat: 30 * MINUTE,
  /** The "Test the connection" button reads Ohme at most this often. */
  testCooldown: 30_000,
  /**
   * Commands (Gladys waits 5 s for the ack): the fresh read and the command
   * must be sent within 3.5 s of the click, or the command is refused unsent;
   * Gladys is answered at 4.3 s at the latest, the request finishing in the
   * background.
   */
  commandSendBy: 3_500,
  commandAck: 4_300,
  commandMinRead: 1_200,
  commandMinSend: 700,
  /** The read that follows a command, to show its effect. */
  refreshAfterCommand: 10_000,
};
