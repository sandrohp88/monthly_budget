/**
 * Which push-subscription endpoints the server will ever send to.
 *
 * A subscription endpoint is a URL the SERVER later POSTs to (lib/push.ts).
 * Accepting any URL gave every signed-in user an outbound-request primitive
 * from inside the container: e.g. https://127.0.0.1:9443/internal
 * (review 2026-09-21 R04). Only the real browser push services are allowed,
 * checked on subscribe AND again before every send (rows stored before this
 * rule existed are not trusted).
 *
 * Pure: no I/O, safe to unit-test and to import from validation.
 */

/** Exact push-service hosts used by current browsers. */
const EXACT_HOSTS = new Set([
  "fcm.googleapis.com", // Chrome, Edge (Chromium), Opera, Samsung on Android
  "android.googleapis.com", // legacy GCM endpoints still issued by some Chromium builds
  "updates.push.services.mozilla.com", // Firefox (autopush)
  "web.push.apple.com", // Safari / iOS home-screen web apps
]);

/** Suffixes matched on a label boundary, e.g. wns2-bl2p.notify.windows.com. */
const HOST_SUFFIXES = [".notify.windows.com"]; // legacy Edge / Windows WNS

export function isAllowedPushEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port !== "" && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  // IP literals (v4 or bracketed v6) are never push services.
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith("[")) return false;
  if (EXACT_HOSTS.has(host)) return true;
  return HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}

/** Decoded length of an unpadded/padded base64url string, or null if malformed. No Buffer: this module is also bundled for the browser. */
function base64UrlBytes(value: string): number | null {
  const m = /^([A-Za-z0-9_-]+)(={0,2})$/.exec(value);
  if (!m) return null;
  const chars = m[1]!.length;
  if (chars % 4 === 1) return null;
  return Math.floor((chars * 3) / 4);
}

/**
 * RFC 8291 key shapes: p256dh is an uncompressed P-256 point (65 bytes,
 * leading 0x04, which always base64url-encodes to a leading "B") and auth is
 * a 16-byte secret. Anything else would only make web-push throw at send time.
 */
export function isValidPushKeys(keys: { p256dh: string; auth: string }): boolean {
  if (base64UrlBytes(keys.p256dh) !== 65 || !keys.p256dh.startsWith("B")) return false;
  return base64UrlBytes(keys.auth) === 16;
}
