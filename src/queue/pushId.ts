/**
 * Firebase-style push ID generator. Produces 20-char keys that are
 * chronologically ordered (timestamp prefix + random suffix), lexicographically
 * sortable — the same ordering guarantee the service relies on for FIFO.
 *
 * Ported from Firebase's public algorithm.
 */
const PUSH_CHARS =
  "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";

let lastPushTime = 0;
const lastRandChars: number[] = [];

export function generatePushId(now: number = Date.now()): string {
  const duplicateTime = now === lastPushTime;
  lastPushTime = now;

  const timeStampChars: string[] = new Array(8);
  let t = now;
  for (let i = 7; i >= 0; i--) {
    timeStampChars[i] = PUSH_CHARS.charAt(t % 64);
    t = Math.floor(t / 64);
  }

  let id = timeStampChars.join("");

  if (!duplicateTime) {
    for (let i = 0; i < 12; i++) {
      lastRandChars[i] = Math.floor(Math.random() * 64);
    }
  } else {
    // increment the previous random suffix to preserve ordering within same ms
    let i = 11;
    for (; i >= 0 && lastRandChars[i] === 63; i--) {
      lastRandChars[i] = 0;
    }
    if (i >= 0) lastRandChars[i]++;
  }

  for (let i = 0; i < 12; i++) {
    id += PUSH_CHARS.charAt(lastRandChars[i]);
  }

  return id;
}
