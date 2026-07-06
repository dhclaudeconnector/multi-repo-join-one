import type { NormalizedPush } from "../types.js";

/** short 7-char sha */
export function shortSha(sha: string): string {
  return (sha ?? "").slice(0, 7);
}

/**
 * Render a commit message template. Supported placeholders:
 *   {message} {sourceRepo} {sha} {shortSha} {provider}
 *   {pusherName} {pusherEmail} {authorName} {authorEmail}
 *   {ref} {branch} {org} {repo} {fullName}
 * Unknown placeholders are left as-is.
 */
export function renderCommitMessage(
  template: string,
  push: NormalizedPush
): string {
  const vars: Record<string, string> = {
    message: push.headCommit.message ?? "",
    sourceRepo: push.fullName,
    sha: push.afterSha,
    shortSha: shortSha(push.afterSha),
    provider: push.provider,
    pusherName: push.pusher.name ?? "",
    pusherEmail: push.pusher.email ?? "",
    authorName: push.headCommit.author.name ?? "",
    authorEmail: push.headCommit.author.email ?? "",
    ref: push.ref,
    branch: push.branch,
    org: push.org,
    repo: push.repo,
    fullName: push.fullName,
  };

  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    return key in vars ? vars[key] : match;
  });
}
