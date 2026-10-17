// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, button, command errors, device,
// feature, status and mode names), in English and French.
// -----------------------------------------------------------------------------

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

/** What a text feature shows when there is nothing to show. */
export const NONE = '—';

const both = (en, fr) => ({ en, fr });

/** Feature names, in the language chosen in the configuration. */
export const FEATURE_NAMES = {
  status: both('Status', 'État'),
  'connector-status': both('Connector', 'Connecteur'),
  'charging-state': both('Charging state', 'État de charge'),
  power: both('Power', 'Puissance'),
  current: both('Current', 'Courant'),
  voltage: both('Voltage', 'Tension'),
  'session-energy': both('Energy of the session', 'Énergie de la session'),
  'vehicle-battery': both('Vehicle battery', 'Batterie du véhicule'),
  'target-percent': both('Battery target', 'Cible de batterie'),
  'charge-end': both('Planned end of charge', 'Fin de charge prévue'),
  'charge-mode': both('Charge mode', 'Mode de charge'),
  'set-target-percent': both('Set the battery target', 'Régler la cible de batterie'),
};

export const STATUS_NAMES = {
  unplugged: both('Unplugged', 'Débranché'),
  pending_approval: both('Waiting for approval', "En attente d'approbation"),
  charging: both('Charging', 'En charge'),
  plugged_in: both('Plugged in', 'Branché'),
  paused: both('Paused', 'En pause'),
  finished: both('Finished', 'Terminé'),
  offline: both('Charger offline', 'Borne hors ligne'),
};

export const MODE_NAMES = {
  smart_charge: both('Smart charge', 'Charge intelligente'),
  max_charge: both('Max charge', 'Charge maximale'),
  paused: both('Paused', 'En pause'),
};

/** "25 min" / "3 h", for the pauses. */
export function age(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const T = {
  noCredentials: both(
    'Enter the e-mail and the password of your Ohme account (those of the Ohme app).',
    "Saisissez l'e-mail et le mot de passe de votre compte Ohme (ceux de l'application Ohme).",
  ),
  connecting: both('Signing in to Ohme…', 'Connexion à Ohme…'),
  connected: (status) =>
    both(
      `Connected to Ohme (${status.en}). Open Discovery to add the charger.`,
      `Connecté à Ohme (${status.fr}). Ouvrez Découverte pour ajouter la borne.`,
    ),
  noCharger: both(
    'Connected to Ohme, but the account has no charger.',
    "Connecté à Ohme, mais le compte n'a aucune borne.",
  ),
  refused: (wait) =>
    both(
      `Ohme refused the e-mail or the password: check them in the configuration. One new try in ${wait.en}, or save corrected credentials, or click "Test the connection".`,
      `Ohme a refusé l'e-mail ou le mot de passe : vérifiez-les dans la configuration. Nouvel essai dans ${wait.fr}, ou enregistrez des identifiants corrigés, ou cliquez sur « Tester la connexion ».`,
    ),
  loginRejected: (status, wait) =>
    both(
      `The sign-in request was rejected (HTTP ${status}): the Ohme API has probably changed, update the integration. One new try in ${wait.en}.`,
      `La demande de connexion a été rejetée (HTTP ${status}) : l'API Ohme a sans doute changé, mettez l'intégration à jour. Nouvel essai dans ${wait.fr}.`,
    ),
  sessionRefused: (wait) =>
    both(
      `Ohme refused the session again right after a renewal: the integration paused. New try in ${wait.en}, or click "Test the connection".`,
      `Ohme a de nouveau refusé la session juste après son renouvellement : l'intégration est en pause. Nouvel essai dans ${wait.fr}, ou cliquez sur « Tester la connexion ».`,
    ),
  busy: both(
    'A read of Ohme is in progress: try again in a minute.',
    'Une lecture de Ohme est en cours : réessayez dans une minute.',
  ),
  unreachable: (reason, wait) =>
    both(
      `Ohme cannot be reached (${reason}). Next try in ${wait.en}.`,
      `Ohme est injoignable (${reason}). Nouvel essai dans ${wait.fr}.`,
    ),
  rateLimited: (wait) =>
    both(
      `Ohme asks to slow down: pausing for ${wait.en}.`,
      `Ohme demande de ralentir : pause de ${wait.fr}.`,
    ),
  forbidden: (wait) =>
    both(
      `Ohme refuses the requests (HTTP 403): pausing for ${wait.en}.`,
      `Ohme refuse les requêtes (HTTP 403) : pause de ${wait.fr}.`,
    ),
  test: {
    cooldown: both(
      'Already read less than 30 seconds ago.',
      'Déjà lu il y a moins de 30 secondes.',
    ),
    summary: ({ name, status, power, battery }) =>
      both(
        `${name}: ${status.en}, ${power} W${battery === undefined ? '' : `, vehicle battery ${battery} %`}.`,
        `${name} : ${status.fr}, ${power} W${battery === undefined ? '' : `, batterie du véhicule ${battery} %`}.`,
      ),
  },
};

/** Command errors: one language, the one of the configuration (Gladys shows the message as is). */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  disabled: both(
    'Commands are disabled: turn on "Allow the commands" in the configuration of the integration.',
    "Les commandes sont désactivées : activez « Autoriser les commandes » dans la configuration de l'intégration.",
  ),
  notConnected: both('Not connected to Ohme.', 'Pas connecté à Ohme.'),
  invalidValue: both('Invalid value.', 'Valeur invalide.'),
  stillRunning: both(
    'A command is still running: try again in a few seconds.',
    'Une commande est encore en cours : réessayez dans quelques secondes.',
  ),
  noVehicle: both('No vehicle is plugged in.', "Aucun véhicule n'est branché."),
  offline: both(
    'The charger is offline for Ohme: the command was not sent.',
    "La borne est hors ligne pour Ohme : la commande n'a pas été envoyée.",
  ),
  pendingApproval: both(
    'The charge is waiting for approval in the Ohme app: approve it there first.',
    "La charge est en attente d'approbation dans l'application Ohme : approuvez-la d'abord.",
  ),
  resumeFirst: both(
    'The charge is paused: choose "Smart charge" first to resume it.',
    "La charge est en pause : choisissez d'abord « Charge intelligente » pour la reprendre.",
  ),
  noRule: both(
    'Ohme gave no charge rule to change.',
    "Ohme n'a donné aucune règle de charge à modifier.",
  ),
  tooSlow: both(
    'Ohme answered too slowly: the command was not sent, try again.',
    "Ohme a répondu trop lentement : la commande n'a pas été envoyée, réessayez.",
  ),
  unknownState: both(
    'The state of the charger could not be read: the command was not sent.',
    "L'état de la borne n'a pas pu être lu : la commande n'a pas été envoyée.",
  ),
  refused: (reason) =>
    both(`Ohme refused the command (${reason}).`, `Ohme a refusé la commande (${reason}).`),
  unsure: (reason) =>
    both(
      `The command may not have reached Ohme (${reason}): check the state before trying again.`,
      `La commande n'est peut-être pas arrivée chez Ohme (${reason}) : vérifiez l'état avant de réessayer.`,
    ),
};
