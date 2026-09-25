/**
 * Post-login destinations. `/login?next=` is attacker-controllable (anyone can
 * send a link), and the login form navigates there after a successful sign-in,
 * where Next's router follows absolute URLs off-site. So only a same-origin
 * path survives; everything else lands on the dashboard (review 2026-09-24 C03).
 *
 * Browser-safe and Edge-safe: used by the login page (server) and the login
 * form (client).
 */

const BASE = "http://next-path.invalid";

export function safeNextPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return "/";
  // "//host" and "/\host" are protocol-relative to a browser; control
  // characters are stripped by the URL parser and can hide either form.
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return "/";
  try {
    const url = new URL(raw, BASE);
    if (url.origin !== BASE) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
