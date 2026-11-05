import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("@/lib/queue/process-webhook", () => ({
  processInstagramWebhook: vi.fn(),
}));
import {
  getUserInfo,
  getUserMedia,
  sendPrivateReply,
  MetaDeliveryUnconfirmedError,
  MetaApiError,
  getAllUserMedia,
} from "@/lib/meta/client";
import {
  getSerriniAuthorizationUrl,
  getSerriniAssets,
  SERRINI_SCOPES,
  exchangeSerriniCode,
  serriniFailureDiagnostic,
} from "@/lib/meta/serrini-unified";
import { isStopRequest } from "@/lib/meta/serrini-suppression";
import { POST } from "@/app/api/webhook/serrini/route";
import { processInstagramWebhook } from "@/lib/queue/process-webhook";

const fetchMock = vi.fn();
const credential = {
  accessToken: "account-token",
  instagramId: "12345",
  loginMode: "UNIFIED" as const,
};
function respond(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status }),
  );
}
function validAssets(scopes = SERRINI_SCOPES, appId = "111") {
  respond({ client_business_id: "222" });
  respond({
    data: {
      is_valid: true,
      app_id: appId,
      scopes,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
  });
  respond({ data: [{ id: "12345", username: "serrini666" }] });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("SERRINI_META_APP_ID", "111");
  vi.stubEnv("SERRINI_META_APP_SECRET", "serrini-secret");
  vi.stubEnv("SERRINI_META_CONFIG_ID", "333");
  vi.stubEnv("SERRINI_META_BUSINESS_ID", "222");
  vi.stubEnv("META_GRAPH_API_VERSION", "v25.0");
});

describe("Serrini per-account Graph routing", () => {
  it("preserves the existing Instagram Login profile route", async () => {
    respond({ id: "legacy", username: "existing" });
    await getUserInfo("legacy-token");
    expect(fetchMock.mock.calls[0][0]).toContain(
      "https://graph.instagram.com/v25.0/me?",
    );
  });
  it("reads a Unified profile by its assigned Instagram ID", async () => {
    respond({ id: "12345", username: "serrini666" });
    await getUserInfo(credential);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe(
      "https://graph.facebook.com/v27.0/12345",
    );
    expect(url.searchParams.get("fields")).not.toContain("user_id");
  });
  it("reads Unified media under the selected account rather than the system user", async () => {
    respond({ data: [] });
    await getUserMedia(credential);
    expect(fetchMock.mock.calls[0][0]).toContain("/v27.0/12345/media?");
  });
  it("sends private replies through the same selected account", async () => {
    respond({ recipient_id: "recipient", message_id: "message" });
    await sendPrivateReply(credential, "12345", "comment", "ECC");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://graph.facebook.com/v27.0/12345/messages",
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer account-token",
    );
  });
  it("leaves a transport failure unknown to prevent an automatic resend", async () => {
    fetchMock.mockRejectedValueOnce(new Error("socket closed"));
    await expect(
      sendPrivateReply(credential, "12345", "comment", "ECC"),
    ).rejects.toBeInstanceOf(MetaDeliveryUnconfirmedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("leaves upstream 5xx responses unknown", async () => {
    respond({ error: { code: 2, message: "temporary" } }, 500);
    await expect(
      sendPrivateReply(credential, "12345", "comment", "ECC"),
    ).rejects.toBeInstanceOf(MetaDeliveryUnconfirmedError);
  });
  it("requires a message receipt even after a 200 response", async () => {
    respond({ success: true });
    await expect(
      sendPrivateReply(credential, "12345", "comment", "ECC"),
    ).rejects.toBeInstanceOf(MetaDeliveryUnconfirmedError);
  });
  it("preserves explicit Graph rejection classification", async () => {
    respond({ error: { code: 100, message: "rejected" } }, 400);
    await expect(
      sendPrivateReply(credential, "12345", "comment", "ECC"),
    ).rejects.toBeInstanceOf(MetaApiError);
  });
  it("rejects pagination to an unrelated host", async () => {
    respond({
      data: [],
      paging: { next: "https://unrelated.example/?access_token=secret" },
    });
    await expect(getAllUserMedia(credential)).rejects.toThrow(
      "Unexpected Graph pagination host",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Serrini OAuth provenance", () => {
  it("reports numeric token failures without persisting upstream credentials", async () => {
    respond({ error: { code: 100, message: "access_token=private-secret" } }, 400);
    try {
      await exchangeSerriniCode("private-code", "https://openreply.example/callback");
      throw new Error("Expected token exchange rejection");
    } catch (error) {
      expect(serriniFailureDiagnostic(error)).toBe("token_exchange:graph_100:unspecified");
      expect(serriniFailureDiagnostic(error)).not.toContain("private");
    }
  });
  it("does not copy unexpected error text into operational records", () => {
    expect(serriniFailureDiagnostic(new Error("secret-token"))).toBe("unexpected_failure");
  });
  it("uses the dedicated parent app and configuration", () => {
    const url = new URL(
      getSerriniAuthorizationUrl(
        "https://openreply.example/callback",
        "signed-state",
      ),
    );
    expect(url.origin + url.pathname).toBe(
      "https://www.facebook.com/dialog/oauth",
    );
    expect(url.searchParams.get("client_id")).toBe("111");
    expect(url.searchParams.get("config_id")).toBe("333");
    expect(url.searchParams.get("scope")).toBeNull();
  });
  it("accepts the documented token without guessing its lifetime", async () => {
    respond({ access_token: "system-token" });
    expect(await exchangeSerriniCode("code", "https://openreply.example/callback")).toEqual({
      access_token: "system-token",
    });
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("redirect_uri")).toBe("https://openreply.example/callback");
  });
  it("binds the account token to the verified business and app", async () => {
    validAssets();
    const result = await getSerriniAssets("system-token");
    expect(result.businessId).toBe("222");
    expect(result.accounts).toEqual([{ id: "12345", username: "serrini666" }]);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
  it("rejects another business portfolio", async () => {
    respond({ client_business_id: "999" });
    respond({ data: {} });
    await expect(getSerriniAssets("system-token")).rejects.toThrow(
      "outside Serrini",
    );
  });
  it("rejects missing account permissions", async () => {
    validAssets(["instagram_basic"]);
    await expect(getSerriniAssets("system-token")).rejects.toThrow(
      "permissions are incomplete",
    );
  });
  it("rejects another app's token", async () => {
    validAssets(SERRINI_SCOPES, "999");
    await expect(getSerriniAssets("system-token")).rejects.toThrow(
      "permissions are incomplete",
    );
  });
});

describe("Serrini webhook isolation and stopping", () => {
  const payload = JSON.stringify({
    object: "instagram",
    entry: [{ id: "12345" }],
  });
  function request(secret: string) {
    return new NextRequest("https://openreply.example/api/webhook/serrini", {
      method: "POST",
      body: payload,
      headers: {
        "x-hub-signature-256":
          "sha256=" +
          createHmac("sha256", secret).update(payload).digest("hex"),
      },
    });
  }
  it("routes only correctly signed new-app events to the bound accounts", async () => {
    expect((await POST(request("serrini-secret"))).status).toBe(200);
    expect(processInstagramWebhook).toHaveBeenCalledWith({
      payload: JSON.parse(payload),
      provider: "META",
      metaAppId: "111",
    });
  });
  it("rejects the old app's signing key", async () => {
    expect((await POST(request("old-secret"))).status).toBe(401);
    expect(processInstagramWebhook).not.toHaveBeenCalled();
  });
  it.each([
    "STOP",
    "unsubscribe",
    "不要再發 ECC",
    "停止回覆",
    "Please stop messaging me",
  ])("recognises a stop request %s", (text) => {
    expect(isStopRequest(text)).toBe(true);
  });
  it.each(["ECC", "AI", "how do I stop this error?", "如何停止這個錯誤"])(
    "allows a regular resource request %s",
    (text) => {
      expect(isStopRequest(text)).toBe(false);
    },
  );
});
