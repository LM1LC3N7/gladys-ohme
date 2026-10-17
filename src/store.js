// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), never the e-mail nor the password:
//   - the Firebase session (token, refresh token, expiry), with the account it
//     belongs to (a hash of the e-mail), so a restart does not sign in again;
//   - the end of a 429 or 403 pause (kept across restarts and account changes);
//   - a stop after a refusal and its next try (per account), so a restart
//     never sends refused credentials again before their time.
// Every time read back is bounded: nothing holds more than 24 h after a
// restart. The file is readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { TIMINGS } from './constants.js';

export const STATE_FILE = '/data/ohme-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

const time = (value) => (Number.isFinite(value) ? value : undefined);
const string = (value, max) =>
  typeof value === 'string' && value !== '' && value.length <= max ? value : undefined;

/** A time read back from /data: in the future, at most 24 h away, else undefined. */
export const bounded = (value, now) => {
  const t = time(value);
  return t !== undefined && t > now ? Math.min(t, now + TIMINGS.persistedMax) : undefined;
};

const STOPS = new Set(['refused', 'login_rejected', 'session_refused']);

/** The persisted state, repaired and bounded. */
export function normalizeMemory(raw, now) {
  const s = raw?.session;
  const session =
    string(s?.account, 64) && string(s?.idToken, 8192) && string(s?.refreshToken, 8192)
      ? {
          account: s.account,
          idToken: s.idToken,
          refreshToken: s.refreshToken,
          expiresAt: time(s.expiresAt) ?? 0,
          renewAt: time(s.renewAt) ?? 0,
          userId: string(s.userId, 128),
        }
      : null;
  const b = raw?.block;
  const retryAt = bounded(b?.retryAt, now);
  const block =
    string(b?.account, 64) && STOPS.has(b?.kind) && retryAt !== undefined
      ? {
          account: b.account,
          kind: b.kind,
          retryAt,
          retries: Number.isInteger(b.retries) && b.retries >= 0 ? Math.min(b.retries, 10) : 0,
          status: Number.isInteger(b.status) ? b.status : undefined,
        }
      : null;
  const pause = raw?.pause;
  const until = bounded(pause?.until, now);
  return {
    session,
    pause:
      until !== undefined && (pause.kind === 'rate' || pause.kind === 'forbidden')
        ? { kind: pause.kind, until }
        : null,
    block,
  };
}
