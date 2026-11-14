// Bloomy — Vietnam time, written once for the server and the browser (runtime code, unlike api-types.ts: the server
// compiles it to shared/vn-time.js, esbuild bundles it into each page script that imports it).
//
// Neither the VPS (UTC) nor a visitor's device can be trusted to be on Vietnam time, so every date or time decision
// that matters goes through these, never a bare `new Date()`: the epoch is shifted by +7 hours and read back with the
// UTC getters, which sidesteps whatever timezone the machine thinks it is in.

export const VN_OFFSET_HOURS = 7;
export const VN_OFFSET_MS = VN_OFFSET_HOURS * 60 * 60 * 1000;

export function nowVN(): Date {
  return new Date(Date.now() + VN_OFFSET_MS);
}

// Minutes since midnight, Vietnam time.
export function nowVNMinutes(): number {
  const d = nowVN();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// "YYYY-MM-DD"
export function todayVNDateString(): string {
  return nowVN().toISOString().slice(0, 10);
}

export function tomorrowVNDateString(): string {
  const d = nowVN();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
