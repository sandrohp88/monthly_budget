import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientIp, hostAllowed, originAllowed } from "./security";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function makeReq(init: { method?: string; headers?: Record<string, string> } = {}): Request {
  return new Request("http://budget.bluefalls.home/api/foo", {
    method: init.method ?? "POST",
    headers: init.headers,
  });
}

describe("clientIp / trusted-proxy semantics", () => {
  it("returns 'unknown' when no proxy is trusted, even if x-forwarded-for is set", () => {
    process.env.TRUST_PROXY_HOPS = "0";
    const req = makeReq({ headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(clientIp(req)).toBe("unknown");
  });

  it("with one trusted hop, returns the rightmost x-forwarded-for entry (the proxy's view of the client)", () => {
    process.env.TRUST_PROXY_HOPS = "1";
    // Hostile client claimed 9.9.9.9 in the first hop; Caddy appended the
    // real socket address 5.5.5.5 on its way through. We must trust only
    // the appended hop.
    const req = makeReq({ headers: { "x-forwarded-for": "9.9.9.9, 5.5.5.5" } });
    expect(clientIp(req)).toBe("5.5.5.5");
  });

  it("with two trusted hops, walks two entries from the right", () => {
    process.env.TRUST_PROXY_HOPS = "2";
    const req = makeReq({ headers: { "x-forwarded-for": "9.9.9.9, 5.5.5.5, 6.6.6.6" } });
    expect(clientIp(req)).toBe("5.5.5.5");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    process.env.TRUST_PROXY_HOPS = "1";
    const req = makeReq({ headers: { "x-real-ip": "7.7.7.7" } });
    expect(clientIp(req)).toBe("7.7.7.7");
  });

  it("ignores x-real-ip when TRUST_PROXY_HOPS=0", () => {
    process.env.TRUST_PROXY_HOPS = "0";
    const req = makeReq({ headers: { "x-real-ip": "7.7.7.7" } });
    expect(clientIp(req)).toBe("unknown");
  });
});

describe("hostAllowed", () => {
  it("blocks unknown hosts in production", () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    process.env.AUTH_URL = "https://budget.bluefalls.home";
    const req = new Request("https://attacker.test/api/foo", {
      method: "POST",
      headers: { host: "attacker.test" },
    });
    expect(hostAllowed(req)).toBe(false);
  });

  it("allows the configured AUTH_URL host", () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    process.env.AUTH_URL = "https://budget.bluefalls.home";
    const req = new Request("https://budget.bluefalls.home/api/foo", {
      method: "POST",
      headers: { host: "budget.bluefalls.home" },
    });
    expect(hostAllowed(req)).toBe(true);
  });

  it("allows everything in dev when no env is set (escape hatch)", () => {
    (process.env as Record<string, string>).NODE_ENV = "development";
    delete process.env.AUTH_URL;
    delete process.env.APP_URL;
    const req = new Request("http://anywhere/api/foo", {
      method: "POST",
      headers: { host: "anywhere" },
    });
    expect(hostAllowed(req)).toBe(true);
  });
});

describe("originAllowed", () => {
  it("permits safe methods (GET) regardless of origin", () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    process.env.AUTH_URL = "https://budget.bluefalls.home";
    const req = new Request("https://budget.bluefalls.home/api/foo", {
      method: "GET",
      headers: { host: "budget.bluefalls.home", origin: "https://attacker.test" },
    });
    expect(originAllowed(req)).toBe(true);
  });

  it("blocks a POST whose Origin doesn't match an allowed host", () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    process.env.AUTH_URL = "https://budget.bluefalls.home";
    const req = new Request("https://budget.bluefalls.home/api/foo", {
      method: "POST",
      headers: { host: "budget.bluefalls.home", origin: "https://attacker.test" },
    });
    expect(originAllowed(req)).toBe(false);
  });

  it("permits a POST whose Origin matches the allowed host", () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    process.env.AUTH_URL = "https://budget.bluefalls.home";
    const req = new Request("https://budget.bluefalls.home/api/foo", {
      method: "POST",
      headers: { host: "budget.bluefalls.home", origin: "https://budget.bluefalls.home" },
    });
    expect(originAllowed(req)).toBe(true);
  });

  it("falls back to host check when Origin header is missing (curl / mobile)", () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    process.env.AUTH_URL = "https://budget.bluefalls.home";
    const req = new Request("https://budget.bluefalls.home/api/foo", {
      method: "POST",
      headers: { host: "budget.bluefalls.home" },
    });
    expect(originAllowed(req)).toBe(true);
  });
});
