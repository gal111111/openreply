import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";

function req(path: string, cookie?: string) {
  return new NextRequest(`https://openreply.example${path}`, {
    headers: cookie ? { cookie } : {},
  });
}

const STALE = "__Secure-authjs.session-token=gone";

describe("proxy login redirects", () => {
  it("sends a visitor with a session cookie from /login to the dashboard", () => {
    const res = proxy(req("/login", STALE));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://openreply.example/dashboard");
  });

  it("shows the login form and clears the cookie when the dashboard rejected it", () => {
    // The dashboard redirects an unmatched cookie to /login?session=expired;
    // bouncing it back would loop /login ↔ /dashboard forever (blank page).
    const res = proxy(req("/login?session=expired", STALE));
    expect(res.headers.get("location")).toBeNull();
    const cleared = res.headers.get("set-cookie") ?? "";
    expect(cleared).toContain("__Secure-authjs.session-token=;");
  });

  it("still sends a visitor without a cookie from a protected page to /login", () => {
    const res = proxy(req("/settings"));
    expect(res.headers.get("location")).toBe(
      "https://openreply.example/login?callbackUrl=%2Fsettings"
    );
  });
});
