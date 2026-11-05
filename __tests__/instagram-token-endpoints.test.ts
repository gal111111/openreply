import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLongLivedToken,
  getUserMedia,
  refreshLongLivedToken,
  TokenExpiredError,
} from "../lib/meta/client";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv("META_GRAPH_API_VERSION", "v25.0");
  vi.stubEnv("INSTAGRAM_APP_SECRET", "test-app-secret");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Instagram token endpoints", () => {
  it("exchanges a short-lived token without a Graph API version", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "long-token", expires_in: 7200 }))
    );

    expect(await getLongLivedToken("short-token")).toEqual({
      accessToken: "long-token",
      expiresIn: 7200,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://graph.instagram.com/access_token");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      grant_type: "ig_exchange_token",
      client_secret: "test-app-secret",
      access_token: "short-token",
    });
  });

  it("refreshes a long-lived token without a version or app secret", async () => {
    vi.stubEnv("META_GRAPH_API_VERSION", "v26.0");
    vi.stubEnv("INSTAGRAM_APP_SECRET", "");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "refreshed-token" }))
    );

    expect(await refreshLongLivedToken("long-token")).toEqual({
      accessToken: "refreshed-token",
      expiresIn: 5184000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://graph.instagram.com/refresh_access_token");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      grant_type: "ig_refresh_token",
      access_token: "long-token",
    });
  });

  it("preserves token error handling", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 190, message: "Token expired" } }), {
        status: 400,
      })
    );

    await expect(refreshLongLivedToken("expired-token")).rejects.toBeInstanceOf(
      TokenExpiredError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary Graph API requests versioned", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })));

    expect(await getUserMedia("long-token")).toEqual([]);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe(
      "https://graph.instagram.com/v25.0/me/media"
    );
  });
});
