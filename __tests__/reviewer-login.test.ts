import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("@/lib/workspace", () => ({ ensureWorkspaceForUser: vi.fn() }));

import {
  isReviewerLoginEnabled,
  sessionCookieName,
  verifyReviewerCredentials,
} from "../lib/reviewer-login";

const PASSWORD = "correct-horse-battery-staple-2026";

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("reviewer login", () => {
  it("is off unless both email and a long password are set", () => {
    expect(isReviewerLoginEnabled()).toBe(false);
    vi.stubEnv("REVIEWER_EMAIL", "reviewer@example.com");
    expect(isReviewerLoginEnabled()).toBe(false);
    vi.stubEnv("REVIEWER_PASSWORD", "too-short");
    expect(isReviewerLoginEnabled()).toBe(false);
    vi.stubEnv("REVIEWER_PASSWORD", PASSWORD);
    expect(isReviewerLoginEnabled()).toBe(true);
  });

  it("accepts only the configured email and password", () => {
    vi.stubEnv("REVIEWER_EMAIL", "Reviewer@Example.com");
    vi.stubEnv("REVIEWER_PASSWORD", PASSWORD);
    expect(verifyReviewerCredentials(" reviewer@example.com ", PASSWORD)).toBe(true);
    expect(verifyReviewerCredentials("reviewer@example.com", `${PASSWORD}x`)).toBe(false);
    expect(verifyReviewerCredentials("someone@example.com", PASSWORD)).toBe(false);
  });

  it("rejects everything when disabled", () => {
    expect(verifyReviewerCredentials("", "")).toBe(false);
  });

  it("still honours ALLOWED_EMAILS", () => {
    vi.stubEnv("REVIEWER_EMAIL", "reviewer@example.com");
    vi.stubEnv("REVIEWER_PASSWORD", PASSWORD);
    vi.stubEnv("ALLOWED_EMAILS", "owner@example.com");
    expect(verifyReviewerCredentials("reviewer@example.com", PASSWORD)).toBe(false);
    vi.stubEnv("ALLOWED_EMAILS", "owner@example.com,reviewer@example.com");
    expect(verifyReviewerCredentials("reviewer@example.com", PASSWORD)).toBe(true);
  });

  it("uses the secure cookie name on https", () => {
    vi.stubEnv("NEXTAUTH_URL", "https://app.example.com");
    expect(sessionCookieName()).toBe("__Secure-authjs.session-token");
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
    expect(sessionCookieName()).toBe("authjs.session-token");
  });
});
