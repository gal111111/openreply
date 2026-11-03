import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeCodeForToken } from "../lib/meta/oauth";

const fetchMock = vi.fn<typeof fetch>();
const token = { access_token: "short-token", user_id: "17841400000000000" };

beforeEach(() => {
  vi.stubEnv("INSTAGRAM_APP_ID", "test-app-id");
  vi.stubEnv("INSTAGRAM_APP_SECRET", "test-app-secret");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Instagram OAuth token responses", () => {
  it.each([
    ["flat", token, token.user_id],
    ["wrapped", { data: [token] }, token.user_id],
    ["numeric user ID", { ...token, user_id: 12345 }, "12345"],
  ])("accepts a valid %s response", async (_name, response, expectedUserId) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(response)));

    const result = await exchangeCodeForToken("auth-code", "https://example.com/callback");
    expect(result).toEqual({
      accessToken: "short-token",
      userId: expectedUserId,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.instagram.com/oauth/access_token");
    expect(request?.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(String(request?.body)))).toEqual({
      client_id: "test-app-id",
      client_secret: "test-app-secret",
      grant_type: "authorization_code",
      redirect_uri: "https://example.com/callback",
      code: "auth-code",
    });
  });

  it.each([
    ["missing fields", {}],
    ["empty token", { ...token, access_token: " " }],
    ["missing user ID", { access_token: "short-token" }],
    ["unsafe numeric user ID", { ...token, user_id: Number.MAX_SAFE_INTEGER + 1 }],
    ["empty data", { data: [] }],
    ["multiple accounts", { data: [token, token] }],
    ["mixed flat and wrapped accounts", { ...token, data: [token] }],
  ])("rejects %s without returning or exposing credentials", async (_name, response) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(response)));

    await expect(
      exchangeCodeForToken("auth-code", "https://example.com/callback")
    ).rejects.toThrow(
      "Instagram returned an invalid token response. Expected exactly one account with an access token and user ID."
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
