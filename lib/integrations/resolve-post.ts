import {
  createInstagramContext,
  type ProviderAccount,
} from "@/lib/instagram/context";
import { getUserMedia } from "@/lib/instagram/read-content";
import { instagramShortcode } from "@/lib/utils/csv";

// Comment matching runs on the media id (Automation.postId), but the Hub only
// knows the public post URL. Look the post up among the account's recent
// media by shortcode. A just-published reel is always near the top.
const RECENT_MEDIA_LIMIT = 50;

export type ResolvePostResult =
  | { ok: true; postId: string; postUrl: string }
  | { ok: false; reason: "invalid_url" | "not_found" | "lookup_failed"; detail?: string };

export async function resolveInstagramPostId(
  account: ProviderAccount,
  postUrl: string
): Promise<ResolvePostResult> {
  const shortcode = instagramShortcode(postUrl);
  if (!shortcode) return { ok: false, reason: "invalid_url" };

  let media;
  try {
    const context = await createInstagramContext(account);
    media = await getUserMedia({ context, limit: RECENT_MEDIA_LIMIT });
  } catch (error) {
    return {
      ok: false,
      reason: "lookup_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const found = media.find(
    (item) => item.permalink && instagramShortcode(item.permalink) === shortcode
  );
  if (!found) return { ok: false, reason: "not_found" };
  return { ok: true, postId: found.id, postUrl: found.permalink ?? postUrl };
}
