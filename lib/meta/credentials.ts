import { getMetaGraphApiVersion } from "@/lib/env";

export type MetaCredential =
  | string
  | {
      accessToken: string;
      instagramId: string;
      loginMode: "UNIFIED";
    };

export function tokenValue(credential: MetaCredential): string {
  return typeof credential === "string" ? credential : credential.accessToken;
}

export function instagramGraphBase(credential: MetaCredential): string {
  return typeof credential === "string"
    ? `https://graph.instagram.com/${getMetaGraphApiVersion()}`
    : "https://graph.facebook.com/v27.0";
}

export function instagramUserPath(credential: MetaCredential): string {
  return typeof credential === "string" ? "me" : credential.instagramId;
}

export function graphNextPage(
  next: string | undefined,
  credential: MetaCredential,
): string | null {
  if (!next) return null;
  const url = new URL(next);
  if (url.origin !== new URL(instagramGraphBase(credential)).origin) {
    throw new Error("Unexpected Graph pagination host");
  }
  return url.toString();
}
