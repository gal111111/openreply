import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLongLivedToken, refreshLongLivedToken } from "../lib/meta/client";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv("META_GRAPH_API_VERSION", "v25.0");
  vi.stubEnv("INSTAGRAM_APP_SECRET", "test-app-secret");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ access_token: "renewed-token", expires_in: 5184000 }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Instagram token lifecycle endpoints", () => {
  it("exchanges a short-lived token through the unversioned endpoint", async () => {
    const result = await getLongLivedToken("short-lived-token");
    const url = new URL(fetchMock.mock.calls[0][0] as string);

    expect(url.origin + url.pathname).toBe("https://graph.instagram.com/access_token");
    expect(url.searchParams.get("grant_type")).toBe("ig_exchange_token");
    expect(url.searchParams.get("client_secret")).toBe("test-app-secret");
    expect(url.searchParams.get("access_token")).toBe("short-lived-token");
    expect(result).toEqual({ accessToken: "renewed-token", expiresIn: 5184000 });
  });

  it("refreshes an existing token through the unversioned endpoint", async () => {
    const result = await refreshLongLivedToken("existing-token");
    const url = new URL(fetchMock.mock.calls[0][0] as string);

    expect(url.origin + url.pathname).toBe("https://graph.instagram.com/refresh_access_token");
    expect(url.searchParams.get("grant_type")).toBe("ig_refresh_token");
    expect(url.searchParams.get("access_token")).toBe("existing-token");
    expect(result).toEqual({ accessToken: "renewed-token", expiresIn: 5184000 });
  });
});
