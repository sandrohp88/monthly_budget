import { describe, expect, it } from "vitest";
import { safeNextPath } from "./safe-redirect";

describe("safeNextPath", () => {
  it.each([
    ["/", "/"],
    ["/bills", "/bills"],
    ["/bills?archived=true#top", "/bills?archived=true#top"],
    ["/credit-cards/card_123", "/credit-cards/card_123"],
    ["/%2F%2Fevil.example", "/%2F%2Fevil.example"],
  ])("keeps the same-origin path %s", (raw, expected) => {
    expect(safeNextPath(raw)).toBe(expected);
  });

  it.each([
    "https://evil.example/login",
    "http://evil.example",
    "//evil.example",
    "///evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "data:text/html,hi",
    "evil.example",
    "/\tevil",
    "/\n/evil.example",
    " /bills",
    "",
    "/".padEnd(3000, "a"),
  ])("falls back to / for %j", (raw) => {
    expect(safeNextPath(raw)).toBe("/");
  });

  it("falls back to / for non-strings", () => {
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath(["/bills"])).toBe("/");
  });
});
