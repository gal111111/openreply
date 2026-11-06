import { afterEach, expect, it, vi } from "vitest";
import { getUserInfo, RateLimitError } from "@/lib/meta/client";

afterEach(() => vi.unstubAllGlobals());

it.each([4, 17, 368])("preserves original Meta code %i and subcode without retrying", async (code) => {
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    error: { code, error_subcode: 123, message: "Test restriction", fbtrace_id: "test-trace" },
  }), { status: 400 }));
  vi.stubGlobal("fetch", request);
  const error = await getUserInfo("test-only").catch(error => error);
  expect(error).toBeInstanceOf(RateLimitError);
  expect(error.code).toBe(code);
  expect(error.subcode).toBe(123);
  expect(error.fbTraceId).toBe("test-trace");
  expect(request).toHaveBeenCalledTimes(1);
});
