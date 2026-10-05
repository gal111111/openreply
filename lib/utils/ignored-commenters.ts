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

/**
 * Single comments that are never auto-answered, e.g. one a person already
 * handled by hand while the commenter's other comments are still answered.
 * OPENREPLY_IGNORE_COMMENT_IDS: comma-separated Instagram comment ids.
 */
export function isIgnoredComment(commentId: string | null | undefined): boolean {
  if (!commentId) return false;
  return (process.env.OPENREPLY_IGNORE_COMMENT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(commentId);
}
