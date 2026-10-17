// -----------------------------------------------------------------------------
// The charger -> one Gladys device and its states (pure).
//
// `ext:<selector>:charger:<serial>`: one device per Ohme charger (the first
// one of the account, as ohmepy). Readings are read only. The two commands are
// `text`/`select` features (never a switch nor a binary: a voice assistant's
// "turn everything off" or a scene must not reach them), refused unless the
// configuration allows them.
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): W, A and V on `energy-sensor` (power,
// current, voltage: instantaneous readings, never an index); kWh and % on
// `electrical-vehicle-charge`; % on `electrical-vehicle-battery`. No energy
// index: Ohme gives no cumulative meter, only the energy of the session.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FEATURES, MODES, STATUS, TARGET_OPTIONS } from './constants.js';
import { FEATURE_NAMES, MODE_NAMES, NONE, STATUS_NAMES, word } from './i18n.js';
import { wallClock } from './model.js';

/** CHARGING_STATION_CONNECTOR_STATUS of the core (server/utils/constants.js). */
export const CONNECTOR_STATUS = {
  AVAILABLE: 0,
  OCCUPIED: 1,
  RESERVED: 2,
  UNAVAILABLE: 3,
  FAULTED: 4,
};

/** CHARGING_STATION_CHARGING_STATE of the core (OCPP 2.0.1 chargingState). */
export const CHARGING_STATE = {
  CHARGING: 0,
  EV_CONNECTED: 1,
  PAUSED_BY_VEHICLE: 2,
  PAUSED_BY_CHARGER: 3,
  IDLE: 4,
  DISCHARGING: 5,
};

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});

const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });

/** The features, by role (the last part of their external id), in display order. */
export const DEFINITIONS = {
  [FEATURES.STATUS]: text,
  [FEATURES.CONNECTOR]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CONNECTOR_STATUS,
    min: 0,
    max: 4,
  }),
  [FEATURES.CHARGING_STATE]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CHARGING_STATE,
    min: 0,
    max: 5,
  }),
  [FEATURES.POWER]: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.POWER,
    unit: U.WATT,
    min: 0,
    max: 50_000,
  }),
  [FEATURES.CURRENT]: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.CURRENT,
    unit: U.AMPERE,
    min: 0,
    max: 100,
  }),
  [FEATURES.VOLTAGE]: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.VOLTAGE,
    unit: U.VOLT,
    min: 0,
    max: 500,
  }),
  [FEATURES.SESSION_ENERGY]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.LAST_CHARGE_ENERGY_ADDED,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 1000,
  }),
  [FEATURES.VEHICLE_BATTERY]: sensor({
    category: C.ELECTRICAL_VEHICLE_BATTERY,
    type: T.ELECTRICAL_VEHICLE_BATTERY.BATTERY_LEVEL,
    unit: U.PERCENT,
    min: 0,
    max: 100,
  }),
  [FEATURES.TARGET]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.TARGET_CHARGE_LIMIT,
    unit: U.PERCENT,
    min: 0,
    max: 100,
  }),
  [FEATURES.CHARGE_END]: text,
};

/** The commands: text/select features, refused unless allowed (src/app.js). */
export const COMMANDS = [FEATURES.MODE, FEATURES.SET_TARGET];

const select = (options) => ({
  category: C.TEXT,
  type: T.TEXT.SELECT,
  min: 0,
  max: 0,
  read_only: false,
  has_feedback: true,
  keep_history: false,
  supported_options: options,
});

export const modeOptions = (language) =>
  Object.values(MODES).map((value) => ({ value, label: word(MODE_NAMES[value], language) }));

export const targetOptions = () =>
  TARGET_OPTIONS.map((value) => ({ value: String(value), label: `${value} %` }));

export const chargerIds = (gladys, serial) => gladys.externalIds('charger', serial);

export function buildDevice(gladys, account, { language }) {
  const ids = chargerIds(gladys, account.serial);
  const features = [
    ...Object.entries(DEFINITIONS).map(([role, definition]) => ({ role, ...definition })),
    { role: FEATURES.MODE, ...select(modeOptions(language)) },
    { role: FEATURES.SET_TARGET, ...select(targetOptions()) },
  ];
  return {
    name: account.name,
    external_id: ids.device,
    ...(account.model ? { model: account.model } : {}),
    should_poll: false,
    features: features.map(({ role, ...definition }) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...definition,
    })),
    params: account.firmware ? [{ name: 'firmware', value: account.firmware }] : [],
  };
}

/** The connector, as the core's charging-station category reads it. */
export function connectorOf(snapshot) {
  if (!snapshot.online) {
    return CONNECTOR_STATUS.UNAVAILABLE;
  }
  return snapshot.pluggedStatus === STATUS.UNPLUGGED
    ? CONNECTOR_STATUS.AVAILABLE
    : CONNECTOR_STATUS.OCCUPIED;
}

/**
 * The charging state (OCPP's chargingState). Unplugged: IDLE (no energy
 * flows), so a scene never keeps reading "charging" after the car left.
 */
export function chargingStateOf(snapshot) {
  switch (snapshot.pluggedStatus) {
    case STATUS.CHARGING:
      return CHARGING_STATE.CHARGING;
    case STATUS.PLUGGED_IN:
      return CHARGING_STATE.EV_CONNECTED;
    case STATUS.PAUSED:
    case STATUS.PENDING_APPROVAL:
      return CHARGING_STATE.PAUSED_BY_CHARGER;
    default:
      return CHARGING_STATE.IDLE;
  }
}

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/** The current values of the charger device (sent when they change). */
export function deviceStates(ids, snapshot, { language, timezone }) {
  const states = [
    [FEATURES.STATUS, { text: word(STATUS_NAMES[snapshot.status], language) }],
    [FEATURES.CONNECTOR, { state: connectorOf(snapshot) }],
  ];
  if (snapshot.online) {
    states.push(
      [FEATURES.CHARGING_STATE, { state: chargingStateOf(snapshot) }],
      [FEATURES.POWER, { state: Math.max(0, Math.round(snapshot.watts)) }],
      [FEATURES.CURRENT, { state: Math.max(0, round(snapshot.amps, 1)) }],
    );
    if (snapshot.volts !== undefined && snapshot.volts >= 0) {
      states.push([FEATURES.VOLTAGE, { state: Math.round(snapshot.volts) }]);
    }
  }
  if (snapshot.energyWh !== undefined) {
    states.push([FEATURES.SESSION_ENERGY, { state: round(snapshot.energyWh / 1000, 3) }]);
  }
  if (snapshot.battery !== undefined) {
    states.push([FEATURES.VEHICLE_BATTERY, { state: snapshot.battery }]);
  }
  if (snapshot.target !== undefined && snapshot.target > 0) {
    states.push([FEATURES.TARGET, { state: snapshot.target }]);
    if (TARGET_OPTIONS.includes(snapshot.target)) {
      states.push([FEATURES.SET_TARGET, { text: String(snapshot.target) }]);
    }
  }
  states.push([
    FEATURES.CHARGE_END,
    { text: snapshot.chargeEnd === undefined ? NONE : wallClock(snapshot.chargeEnd, timezone) },
  ]);
  if (snapshot.mode !== undefined) {
    states.push([FEATURES.MODE, { text: snapshot.mode }]);
  }
  return states.map(([role, value]) => ({
    device_feature_external_id: ids.feature(role),
    ...value,
  }));
}
