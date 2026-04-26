import { randomBytes } from "node:crypto";

/** Short, URL-safe, sortable-ish opaque id. Not a UUID — easier to read in URLs. */
export function newId(): string {
  return randomBytes(12).toString("base64url");
}
