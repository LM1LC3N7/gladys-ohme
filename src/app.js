// -----------------------------------------------------------------------------
// The integration: the Ohme account (e-mail and password), one read of the
// charge session per cycle (every minute while charging, every 5 minutes
// otherwise), the account every 30 minutes, the Gladys device and its states,
// the transport badge, the "Test the connection" button, and the two commands
// (charge mode, battery target), refused unless the configuration allows them.
// index.js only wires the SDK handlers to it.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { OhmeClient } from './client.js';
import { normalizeConfig } from './config.js';
import { FEATURES, MODES, PATHS, STATUS, TARGET_OPTIONS, TIMINGS } from './constants.js';
import { COMMANDS, buildDevice, chargerIds, deviceStates } from './devices.js';
import { ERRORS, STATUS_NAMES, T, age, word } from './i18n.js';
import { inProgress, intervalOf, readAccount, readSnapshot, statusOf } from './model.js';
import { OhmeError, errorReason } from './ohme.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

/** Errors Ohme did not answer usefully for: the account is unreachable. */
const OFFLINE = new Set(['network', 'timeout', 'unavailable', 'bad_response', 'size', 'http']);
/** Errors that stop the polling, with the spaced new tries of each. */
const STOPS = {
  refused: TIMINGS.refusedRetry,
  login_rejected: TIMINGS.refusedRetry,
  session_refused: TIMINGS.sessionRetry,
};
/**
 * Errors of a command that also hold every other path (a 429 pause or a
 * stop). A 403 on a command is only that command refused: only a 403 of the
 * main read, after a renewal, pauses everything.
 */
const HOLDS = new Set(['rate_limited', ...Object.keys(STOPS)]);

const MODE_VALUES = Object.values(MODES);

export class OhmeApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'ohme' }),
    transport,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.client = new OhmeClient({ transport, now, onChange: () => this.persist() });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    /** The first charger of the account (readAccount), and when it was read. */
    this.account = undefined;
    this.accountAt = -Infinity;
    /** The last read (readSnapshot) and the next session's rule. */
    this.snapshot = undefined;
    this.nextRule = {};
    this.published = undefined;
    this.badge = undefined;
    this.timer = undefined;
    this.running = undefined;
    this.generation = 0;
    /** A stop after a refusal: { kind, retryAt, retries, status }, else undefined. */
    this.block = undefined;
    /** The stop being tried again (its count of tries goes on). */
    this.retrying = undefined;
    this.offline = false;
    this.connectedOnce = false;
    this.failures = 0;
    this.pausedUntil = 0;
    /** 'rate' (a 429: every path waits), 'forbidden' (every path too) or 'backoff'. */
    this.pauseKind = undefined;
    this.lastTestAt = -Infinity;
    this.started = false;
    this.lastStatus = undefined;
    /** A command in flight (one at a time). */
    this.commanding = false;
    this.warnedChargers = false;
    /** Secondary endpoints skipped after a 403: name -> until (ms). */
    this.skipUntil = {};
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}, { clearBlock = false } = {}) {
    this.stop();
    await this.running;
    this.config = normalizeConfig(raw);
    this.reset();
    this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
    const { email, password, account } = this.config;
    if (clearBlock && (this.memory.block || this.memory.session)) {
      this.memory.block = null;
      this.memory.session = null;
      await this.saveMemory();
    }
    // A 429 or 403 pause survives a restart and a change of account.
    const pause = this.memory.pause;
    if (pause && pause.until > Math.max(this.now(), this.pausedUntil)) {
      this.pausedUntil = pause.until;
      this.pauseKind = pause.kind;
    }
    const session = this.memory.session?.account === account ? this.memory.session : null;
    this.client.configure({ email, password, session });
    const block = this.memory.block?.account === account ? this.memory.block : null;
    this.block = block
      ? { kind: block.kind, retryAt: block.retryAt, retries: block.retries, status: block.status }
      : undefined;
    this.publisher.start();
    if (!this.client.hasCredentials) {
      await this.setStatus(false, T.noCredentials);
      return;
    }
    if (this.block) {
      // Stopped before the restart: the next try keeps its time.
      await this.setStatus(false, this.blockMessage());
      this.scheduleNext();
      return;
    }
    await this.setStatus(false, this.pauseMessage() ?? T.connecting);
    await this.tick();
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    this.publisher.stop();
  }

  clearTimer() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Forgets the account and the failures: a new account, or a restart. A 429/403 pause stays. */
  reset() {
    this.account = undefined;
    this.accountAt = -Infinity;
    this.snapshot = undefined;
    this.nextRule = {};
    this.published = undefined;
    this.badge = undefined;
    this.block = undefined;
    this.retrying = undefined;
    this.offline = false;
    this.connectedOnce = false;
    this.failures = 0;
    this.skipUntil = {};
    if (this.pauseKind === 'backoff' || this.now() >= this.pausedUntil) {
      this.pausedUntil = 0;
      this.pauseKind = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badge) and the last states. The pauses, the stops and the session
   * stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw);
    this.published = undefined;
    this.badge = undefined;
    const status = this.lastStatus;
    this.lastStatus = undefined;
    if (status) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    await this.publishDevice();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
  }

  /** New credentials restart (and lift a stop); a new language or timezone renames. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    const previous = this.config;
    if (next.email !== previous.email || next.password !== previous.password) {
      // New credentials: the stop is lifted and the old session forgotten
      // (a password changed for the same e-mail must be checked again).
      return this.start(raw, { clearBlock: true });
    }
    this.config = next;
    if (next.language !== previous.language || next.timezone !== previous.timezone) {
      await this.publishDevice();
      this.queueStates();
      await this.flush();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The message of the last status (multi-language), or undefined. */
  get lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? undefined;
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  /** The session of the client, with its account. */
  async persist() {
    const { session } = this.client;
    this.memory.session = session ? { account: this.config.account, ...session } : null;
    await this.saveMemory();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return intervalOf(this.snapshot, {
      charging: TIMINGS.chargingInterval,
      idle: TIMINGS.idleInterval,
    });
  }

  /** The next read: at the stop's next try, after the pause, else the interval (or `delay`). */
  scheduleNext(delay) {
    this.clearTimer();
    if (!this.client.hasCredentials) {
      return;
    }
    const now = this.now();
    let wait;
    if (this.block) {
      wait = this.block.retryAt - now;
    } else if (now < this.pausedUntil) {
      wait = this.pausedUntil - now;
    } else {
      wait = delay ?? this.interval;
    }
    const generation = this.generation;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch(() => this.logger.error('Ohme refresh failed'));
        }
      },
      Math.max(0, wait),
    );
  }

  /** One run at a time: a tick during a run joins it. `quick`: for the button. */
  tick({ quick = false } = {}) {
    if (!this.running) {
      this.running = this.run({ quick }).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  /**
   * A secondary read failed: logged (code only), never a stop. A 403 skips
   * that endpoint for an hour (no renewal per cycle for it); only a 429 is
   * passed on, to pause every path once the main data is shown.
   */
  secondary(err, what) {
    this.logger.info(`Ohme ${what} not read: ${errorReason(err)}`);
    if (err.kind === 'forbidden') {
      this.skipUntil[what] = this.now() + TIMINGS.secondaryForbiddenSkip;
    }
    return err.kind === 'rate_limited' ? err : undefined;
  }

  /** Whether a secondary endpoint is skipped after a 403. */
  skipped(what) {
    return this.now() < (this.skipUntil[what] ?? 0);
  }

  noteAccount(account) {
    this.account = account;
    this.accountAt = this.now();
    if (account.chargers > 1 && !this.warnedChargers) {
      this.warnedChargers = true;
      this.logger.warn(`Ohme: ${account.chargers} chargers, only the first one is shown`);
    }
  }

  async run({ quick = false } = {}) {
    const generation = this.generation;
    if (!this.client.hasCredentials) {
      return;
    }
    if (this.block && this.now() >= this.block.retryAt) {
      // The spaced new try of a stop.
      this.logger.info('Ohme: trying again after a stop');
      this.retrying = this.block;
      this.block = undefined;
    }
    if (this.block || this.now() < this.pausedUntil) {
      this.scheduleNext();
      return;
    }
    this.client.beginCycle();
    this.client.timeout = quick ? TIMINGS.quickTimeout : undefined;
    // The test button: one deadline for the whole run, within its 60 s.
    const options = quick ? { deadline: this.now() + TIMINGS.quickBudget } : {};
    let held;
    try {
      // The account is needed once (the serial is the device id).
      if (!this.account) {
        const account = readAccount(await this.client.account(options));
        if (!account) {
          throw new OhmeError('no_charger', 'no charger on this account');
        }
        this.noteAccount(account);
      }
      const session = await this.client.chargeSession(options);
      if (generation !== this.generation) {
        return;
      }
      const before = this.snapshot;
      await this.apply(
        readSnapshot({ session, nextRule: this.nextRule, previous: before }, this.now()),
      );
      await this.succeeded();

      // Secondary reads, after the main data is shown: no renewal, no new try.
      const secondary = { ...options, secondary: true };
      if (this.now() - this.accountAt >= TIMINGS.accountInterval && !this.skipped('account')) {
        try {
          const account = readAccount(await this.client.account(secondary));
          if (account) {
            this.noteAccount(account);
          }
        } catch (err) {
          held = this.secondary(err, 'account') ?? held;
        }
      }
      if (!this.skipped('next session')) {
        try {
          this.nextRule = await this.client.nextSession(secondary);
        } catch (err) {
          held = this.secondary(err, 'next session') ?? held;
        }
      }
      if (generation !== this.generation) {
        return;
      }
      await this.apply(
        readSnapshot({ session, nextRule: this.nextRule, previous: before }, this.now()),
      );
      if (held) {
        await this.failed(held);
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      await this.failed(err);
    } finally {
      this.client.timeout = undefined;
    }
    await this.publishBadge();
    await this.flush();
    if (generation === this.generation) {
      this.scheduleNext();
    }
  }

  async succeeded() {
    this.failures = 0;
    this.offline = false;
    this.connectedOnce = true;
    this.retrying = undefined;
    if (this.pauseKind === 'backoff') {
      this.pauseKind = undefined;
    }
    if (this.memory.block) {
      this.memory.block = null;
      await this.saveMemory();
    }
    await this.setStatus(true, T.connected(STATUS_NAMES[this.snapshot.status]));
  }

  blockMessage() {
    const wait = age(Math.max(0, this.block.retryAt - this.now()));
    switch (this.block.kind) {
      case 'refused':
        return T.refused(wait);
      case 'login_rejected':
        return T.loginRejected(this.block.status ?? '?', wait);
      default:
        return T.sessionRefused(wait);
    }
  }

  async failed(err) {
    const reason = errorReason(err);
    const schedule = STOPS[err.kind];
    if (schedule) {
      // Never signed in again in a loop: refusals may lock the account. One
      // new try after 6 h then every 24 h (1 h, 6 h, 24 h for a refused session).
      const retries = this.retrying?.retries ?? 0;
      const wait = schedule[Math.min(retries, schedule.length - 1)];
      this.block = {
        kind: err.kind,
        retryAt: this.now() + wait,
        retries: retries + 1,
        status: err.status,
      };
      this.retrying = undefined;
      this.memory.block = { account: this.config.account, ...this.block };
      await this.saveMemory();
      this.logger.warn(`Ohme stopped: ${reason}; one new try in ${Math.round(wait / 60_000)} min`);
      await this.setStatus(false, this.blockMessage());
      return;
    }
    if (err.kind === 'no_credentials') {
      await this.setStatus(false, T.noCredentials);
      return;
    }
    let wait;
    let message;
    if (err.kind === 'rate_limited') {
      wait = Math.min(
        TIMINGS.rateLimitMax,
        Math.max(TIMINGS.rateLimitMin, err.retryAfter ?? TIMINGS.rateLimitDefault),
      );
      this.pauseKind = 'rate';
      message = T.rateLimited(age(wait));
    } else if (err.kind === 'forbidden') {
      wait = TIMINGS.forbiddenPause;
      this.pauseKind = 'forbidden';
      this.offline = true;
      message = T.forbidden(age(wait));
    } else {
      // Never read again sooner than the interval.
      wait = Math.max(
        this.interval,
        TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)],
      );
      this.pauseKind = 'backoff';
      this.offline = OFFLINE.has(err.kind) || this.offline;
      message = err.kind === 'no_charger' ? T.noCharger : T.unreachable(reason, age(wait));
    }
    this.failures += 1;
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    if (this.pauseKind === 'rate' || this.pauseKind === 'forbidden') {
      this.memory.pause = { kind: this.pauseKind, until: this.pausedUntil };
      await this.saveMemory();
    }
    const connected = err.kind === 'rate_limited' && this.connectedOnce;
    await this.setStatus(connected, message);
    this.logger.warn(`Ohme: ${reason}; next try in ${Math.round(wait / 1000)} s`);
  }

  async apply(snapshot) {
    this.snapshot = snapshot;
    await this.publishDevice();
    this.queueStates();
  }

  // --- Gladys ----------------------------------------------------------------

  get ids() {
    return this.account ? chargerIds(this.gladys, this.account.serial) : undefined;
  }

  async publishDevice() {
    if (!this.account || !this.snapshot) {
      return;
    }
    const device = buildDevice(this.gladys, this.account, this.config);
    const json = JSON.stringify(device);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices([device]);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered device failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  queueStates(created = this.createdFeatures()) {
    if (!this.snapshot || !this.account) {
      return;
    }
    for (const { device_feature_external_id: id, ...value } of deviceStates(
      this.ids,
      this.snapshot,
      this.config,
    )) {
      if (created.has(id)) {
        this.publisher.push(id, value);
      }
    }
  }

  async publishBadge() {
    if (!this.account) {
      return;
    }
    const externalId = this.ids.device;
    if (!(this.gladys.devices ?? []).some((d) => d.external_id === externalId)) {
      return;
    }
    const unreachable = this.block || this.offline || this.snapshot?.online === false;
    const entry = {
      external_id: externalId,
      transport: unreachable ? DEVICE_TRANSPORTS.UNREACHABLE : DEVICE_TRANSPORTS.CLOUD,
    };
    const json = JSON.stringify(entry);
    if (json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports([entry]);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (device?.external_id) {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device of the last read (no extra request). */
  async scan() {
    await this.publishDevice();
  }

  // --- Configuration button ------------------------------------------------------

  /** A 429 or 403 pause holds for every path, buttons and commands included. */
  pauseMessage() {
    const left = this.pausedUntil - this.now();
    if (left <= 0) {
      return undefined;
    }
    if (this.pauseKind === 'rate') {
      return T.rateLimited(age(left));
    }
    return this.pauseKind === 'forbidden' ? T.forbidden(age(left)) : undefined;
  }

  async testConnection() {
    if (!this.client.hasCredentials) {
      return T.noCredentials;
    }
    const paused = this.pauseMessage();
    if (paused) {
      return paused;
    }
    // At most one read per 30 s from this button, whatever happened before.
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown) {
      const last = this.snapshot && !this.block ? this.summary() : this.lastMessage;
      return last
        ? { en: `${T.test.cooldown.en} ${last.en}`, fr: `${T.test.cooldown.fr} ${last.fr}` }
        : T.test.cooldown;
    }
    if (this.running) {
      return T.busy;
    }
    this.lastTestAt = this.now();
    // One try per click: the button is how a stopped account is tried again.
    if (this.block) {
      this.retrying = this.block;
      this.block = undefined;
    }
    this.pausedUntil = 0;
    this.pauseKind = undefined;
    await this.tick({ quick: true });
    const [connected, message] = JSON.parse(this.lastStatus ?? '[false,null]');
    if (!connected || !this.snapshot) {
      return message ?? T.noCredentials;
    }
    return this.summary();
  }

  summary() {
    return T.test.summary({
      name: this.account?.name ?? 'Ohme',
      status: STATUS_NAMES[this.snapshot.status],
      power: Math.round(this.snapshot.watts),
      battery: this.snapshot.battery,
    });
  }

  // --- Commands --------------------------------------------------------------------

  /** The role of one of our feature external ids, else undefined. */
  roleOf(externalId) {
    const ids = this.ids;
    if (!ids || typeof externalId !== 'string') {
      return undefined;
    }
    return Object.values(FEATURES).find((role) => ids.feature(role) === externalId);
  }

  error(text) {
    return new Error(word(text, this.config.language));
  }

  /** A command from Gladys (mode or battery target): checks, a fresh read, then one request. */
  async setValue(device, feature, value) {
    const received = this.now();
    const role = this.roleOf(feature?.external_id);
    if (!role || !COMMANDS.includes(role)) {
      throw this.error(ERRORS.readOnly);
    }
    if (!this.config.allowCommands) {
      throw this.error(ERRORS.disabled);
    }
    if (!this.client.hasCredentials || this.block || !this.account) {
      throw this.error(ERRORS.notConnected);
    }
    const paused = this.pauseMessage();
    if (paused) {
      throw this.error(paused);
    }
    if (this.commanding) {
      throw this.error(ERRORS.stillRunning);
    }
    let wanted;
    if (role === FEATURES.MODE) {
      wanted = String(value);
      if (!MODE_VALUES.includes(wanted)) {
        throw this.error(ERRORS.invalidValue);
      }
    } else {
      wanted = Number(value);
      if (!TARGET_OPTIONS.includes(wanted)) {
        throw this.error(ERRORS.invalidValue);
      }
    }
    this.commanding = true;
    let background;
    try {
      ({ background } = await this.command({
        role,
        wanted,
        received,
        generation: this.generation,
      }));
    } finally {
      if (background) {
        background.finally(() => {
          this.commanding = false;
        });
      } else {
        this.commanding = false;
      }
    }
  }

  /** A command error that holds every path (429, a stop) is applied like a polling one. */
  async hold(err) {
    if (HOLDS.has(err.kind)) {
      await this.failed(err);
      await this.publishBadge();
      this.scheduleNext();
      return this.pauseMessage() ?? (this.block ? this.blockMessage() : undefined);
    }
    return undefined;
  }

  /** The request a command needs, from the state just read; undefined when nothing is to do. */
  plan(role, wanted, current) {
    const serial = this.account.serial;
    if (!current.online) {
      throw this.error(ERRORS.offline);
    }
    if (role === FEATURES.MODE) {
      if (current.pluggedStatus === STATUS.PENDING_APPROVAL) {
        throw this.error(ERRORS.pendingApproval);
      }
      if (!inProgress(current.pluggedStatus)) {
        throw this.error(ERRORS.noVehicle);
      }
      if (current.mode === wanted) {
        return undefined;
      }
      if (wanted === MODES.PAUSED) {
        return { method: 'POST', path: PATHS.stop(serial) };
      }
      if (wanted === MODES.SMART_CHARGE) {
        return current.mode === MODES.PAUSED
          ? { method: 'POST', path: PATHS.resume(serial) }
          : { method: 'PUT', path: PATHS.maxCharge(serial, false) };
      }
      if (current.mode === MODES.PAUSED) {
        throw this.error(ERRORS.resumeFirst);
      }
      return { method: 'PUT', path: PATHS.maxCharge(serial, true) };
    }
    if (!current.ruleId) {
      throw this.error(ERRORS.noRule);
    }
    if (current.target === wanted) {
      return undefined;
    }
    return {
      method: 'PATCH',
      path: PATHS.chargeRule(current.ruleId),
      payload: { targetPercent: wanted },
    };
  }

  /**
   * Reads the session, decides, sends. Gladys waits 5 s: nothing is sent
   * later than 3.5 s after the click, and Gladys is answered at 4.3 s at the
   * latest (the request then finishes in the background, whose promise is
   * returned as `background`).
   */
  async command({ role, wanted, received, generation }) {
    const sendBy = received + TIMINGS.commandSendBy;
    if (sendBy - this.now() < TIMINGS.commandMinRead) {
      throw this.error(ERRORS.tooSlow);
    }
    let current;
    try {
      const deadline = sendBy - TIMINGS.commandMinSend;
      const session = await this.client.chargeSession({ deadline });
      let nextRule = this.nextRule;
      if (role === FEATURES.SET_TARGET && !inProgress(statusOf(session))) {
        // The target of the next session: its rule is read again too, never
        // decided on the one in memory.
        nextRule = await this.client.nextSession({ deadline, secondary: true });
        this.nextRule = nextRule;
      }
      current = readSnapshot({ session, nextRule, previous: this.snapshot }, this.now());
    } catch (err) {
      const held = await this.hold(err);
      throw this.error(held ?? ERRORS.unknownState);
    }
    if (generation !== this.generation || this.block) {
      throw this.error(ERRORS.notConnected);
    }
    if (!this.config.allowCommands) {
      throw this.error(ERRORS.disabled);
    }
    const plan = this.plan(role, wanted, current);
    if (!plan) {
      // Already so: show the state just read.
      await this.apply(current);
      await this.flush();
      return {};
    }
    if (sendBy - this.now() < TIMINGS.commandMinSend) {
      throw this.error(ERRORS.tooSlow);
    }
    this.logger.info(`Ohme command: ${role} -> ${wanted}`);
    const request = this.client.command(plan.method, plan.path, {
      payload: plan.payload,
      sendBy,
    });
    let handle;
    const ack = new Promise((resolve) => {
      handle = this.timers.setTimeout(
        () => resolve({ pending: true }),
        Math.max(0, received + TIMINGS.commandAck - this.now()),
      );
    });
    const outcome = await Promise.race([
      request.then(
        () => ({ done: true }),
        (err) => ({ err }),
      ),
      ack,
    ]);
    this.timers.clearTimeout(handle);
    if (outcome.done) {
      this.scheduleNext(TIMINGS.refreshAfterCommand);
      return {};
    }
    if (outcome.pending) {
      // Sent, Ohme still at work: Gladys is answered now, the state follows.
      const background = request
        .then(
          () => this.logger.info(`Ohme command ${role} done`),
          async (err) => {
            this.logger.warn(`Ohme command ${role} failed: ${errorReason(err)}`);
            // A late 429 (or 403, or a stop) still holds every path.
            if (generation === this.generation) {
              await this.hold(err);
            }
          },
        )
        .finally(() => {
          if (generation === this.generation) {
            this.scheduleNext(TIMINGS.refreshAfterCommand);
          }
        });
      return { background };
    }
    const { err } = outcome;
    const held = await this.hold(err);
    if (held) {
      throw this.error(held);
    }
    this.scheduleNext(TIMINGS.refreshAfterCommand);
    const reason = errorReason(err);
    this.logger.warn(`Ohme command ${role} failed: ${reason}`);
    if (err.notSent) {
      throw this.error(ERRORS.tooSlow);
    }
    if (err.status) {
      throw this.error(ERRORS.refused(reason));
    }
    throw this.error(ERRORS.unsure(reason));
  }
}
