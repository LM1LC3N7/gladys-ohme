// -----------------------------------------------------------------------------
// Made-up Ohme answers, shaped like what ohmepy reads (no real account was
// available: the field names are those ohmepy and Home Assistant use).
// -----------------------------------------------------------------------------

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 2026-10-17 12:00 UTC (14:00 in Paris). */
export const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

export const EMAIL = 'driver@example.com';
export const PASSWORD = 'Sécret-Pass 42!';
export const SERIAL = 'ABC123DEF456';
export const USER_ID = 'firebase-user-1';

/** A JWT-shaped token (unsigned) carrying `claims`. */
export const jwt = (claims) =>
  [
    Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'signature',
  ].join('.');

export const account = (overrides = {}) => ({
  userSettings: { chargeSettings: [{ enabled: false, value: 20 }] },
  tariff: null,
  cars: [{ id: 'car-1', name: 'My EV' }],
  chargeDevices: [
    {
      id: SERIAL,
      modelTypeDisplayName: 'Ohme Home Pro',
      firmwareVersionLabel: 'v2.70',
      modelCapabilities: { pluginsRequireApprovalMode: true },
      optionalSettings: {},
    },
  ],
  ...overrides,
});

/** The charge session while charging in smart mode, with two planned slots. */
export const charging = (now = NOW, overrides = {}) => ({
  mode: 'SMART_CHARGE',
  chargerStatus: { online: true },
  power: { watt: 7200, amp: 31.3, volt: 230 },
  batterySoc: { wh: 4520, percent: 55 },
  car: { batterySoc: { percent: 56 } },
  appliedRule: { id: 'rule-1', targetPercent: 80, targetTime: 25_200 },
  allSessionSlots: [
    { startTimeMs: now - HOUR, endTimeMs: now + 30 * MINUTE, watts: 7000 },
    { startTimeMs: now + 2 * HOUR, endTimeMs: now + 3 * HOUR + 30 * MINUTE, watts: 7000 },
  ],
  ...overrides,
});

export const unplugged = (overrides = {}) => ({
  mode: 'DISCONNECTED',
  chargerStatus: { online: true },
  power: { watt: 0, amp: 0, volt: 238 },
  batterySoc: null,
  car: null,
  appliedRule: null,
  allSessionSlots: [],
  ...overrides,
});

export const paused = (now = NOW, overrides = {}) =>
  charging(now, {
    mode: 'STOPPED',
    power: { watt: 0, amp: 0, volt: 231 },
    suspendedRule: { id: 'rule-1', targetPercent: 90 },
    ...overrides,
  });

export const nextRule = (overrides = {}) => ({
  rule: { id: 'rule-next', targetPercent: 70, targetTime: 27_000, ...overrides },
});
