/**
 * Usernames whose comments are never auto-answered: people already handled by
 * hand, or anyone the account owner does not want messaged. Set
 * OPENREPLY_IGNORE_COMMENTERS to a comma-separated list (a leading @ is fine).
 */
export function isIgnoredCommenter(username: string | null | undefined): boolean {
  if (!username) return false;
  const ignored = (process.env.OPENREPLY_IGNORE_COMMENTERS ?? "")
    .split(",")
    .map((name) => name.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  return ignored.includes(username.toLowerCase());
}
