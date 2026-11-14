import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessageMetadata, MetaApiError } from "@/lib/meta/client";

const token = "private-test-token";
const originalMessage = {
  id: "native-outgoing",
  from: { id: "owner" },
  to: { data: [{ id: "recipient" }] },
  created_time: "2026-11-14T17:11:49+0000",
  message: "",
};

function respond(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("exact native message metadata", () => {
  it("uses the original trusted Graph host and a fixed read-only field selection", async () => {
    const fetchMock = respond(originalMessage);
    await getMessageMetadata(token, originalMessage.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0];
    const url = new URL(input);
    expect(url.origin).toBe("https://graph.instagram.com");
    expect(url.pathname).toMatch(/\/native-outgoing$/);
    expect(url.searchParams.get("fields")).toBe(
      "id,created_time,from,to,is_unsupported,attachments{id,generic_template}"
    );
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${token}`);
    expect(init.cache).toBe("no-store");
    expect(init.body).toBeUndefined();
  });

  it("keeps an absent attachment projection unknown for an empty-text native message", async () => {
    respond(originalMessage);
    expect(await getMessageMetadata(token, originalMessage.id)).toMatchObject({
      id: originalMessage.id,
      fromId: "owner",
      toIds: ["recipient"],
      attachmentsReturned: false,
      attachmentCount: null,
      isUnsupported: null,
      attachments: [],
    });
  });

  it("distinguishes a returned empty attachment list from omitted data", async () => {
    respond({ ...originalMessage, attachments: { data: [] }, is_unsupported: false });
    expect(await getMessageMetadata(token, originalMessage.id)).toMatchObject({
      attachmentsReturned: true, attachmentCount: 0, isUnsupported: false,
    });
  });

  it("projects CTA metadata while excluding attachment bodies and signed query values", async () => {
    const fetchMock = respond({
      ...originalMessage,
      is_unsupported: true,
      attachments: { data: [{
        id: "attachment",
        file_url: "https://private.example/file?signed=private",
        image_data: { url: "https://private.example/image" },
        generic_template: {
          subtitle: "private attachment body",
          cta: {
            type: "web_url", title: "免費人才登記",
            url: "https://user:password@openreply.example/r/tracked?signed=private#secret",
          },
        },
      }] },
    });
    const result = await getMessageMetadata(token, originalMessage.id);
    expect(result.attachments[0]).toEqual({
      id: "attachment", hasGenericTemplate: true,
      callToAction: {
        type: "web_url", title: "免費人才登記",
        urlOrigin: "https://openreply.example", urlPath: "/r/tracked", hasQuery: true,
      },
    });
    expect(result.isUnsupported).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/password|signed=|private attachment|file_url|image_data/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["javascript:alert(1)", "not a URL", `https://example.com/${token}`])(
    "withholds unsafe URL metadata without fetching it (%s)", async (url) => {
      const fetchMock = respond({
        ...originalMessage,
        attachments: { data: [{ generic_template: { cta: { url } } }] },
      });
      const result = await getMessageMetadata(token, originalMessage.id);
      expect(result.attachments[0].callToAction?.urlOrigin).toBeNull();
      expect(result.attachments[0].callToAction?.urlPath).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it("retains the original unified connection's Graph host", async () => {
    const fetchMock = respond(originalMessage);
    await getMessageMetadata({ accessToken: token, instagramId: "owner", loginMode: "UNIFIED" }, originalMessage.id);
    expect(new URL(fetchMock.mock.calls[0][0]).origin).toBe("https://graph.facebook.com");
  });

  it("propagates an upstream field or permission refusal without claiming empty attachments", async () => {
    respond({ error: { code: 100, message: "Field unavailable" } }, 400);
    await expect(getMessageMetadata(token, originalMessage.id)).rejects.toBeInstanceOf(MetaApiError);
  });
});
