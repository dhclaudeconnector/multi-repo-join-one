import type { NormalizedPush } from "../types.js";

/** Extract the branch name from a git ref ("refs/heads/main" -> "main"). */
export function branchFromRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
}

/**
 * Normalize a GitHub `push` webhook payload into NormalizedPush.
 * Throws if required fields are missing.
 */
export function normalizeGithub(
  raw: any,
  deliveryId?: string
): NormalizedPush {
  if (!raw || typeof raw !== "object") {
    throw new Error("github: payload is not an object");
  }

  const repository = raw.repository;
  if (!repository || typeof repository.name !== "string") {
    throw new Error("github: missing repository.name");
  }

  const fullName: string =
    typeof repository.full_name === "string"
      ? repository.full_name
      : `${repository.owner?.name ?? repository.owner?.login ?? ""}/${repository.name}`;

  const org =
    repository.owner?.login ??
    repository.owner?.name ??
    fullName.split("/")[0] ??
    "";

  const ref: string = raw.ref ?? "";
  if (!ref) throw new Error("github: missing ref");

  const afterSha: string = raw.after ?? raw.head_commit?.id ?? "";
  if (!afterSha) throw new Error("github: missing after SHA");

  const cloneUrl: string =
    repository.clone_url ??
    repository.git_url ??
    `https://github.com/${fullName}.git`;

  const head = raw.head_commit ?? {};

  return {
    provider: "github",
    org,
    repo: repository.name,
    fullName,
    ref,
    branch: branchFromRef(ref),
    beforeSha: raw.before ?? "",
    afterSha,
    cloneUrl,
    pusher: {
      name: raw.pusher?.name ?? head.author?.name ?? "",
      email: raw.pusher?.email ?? head.author?.email ?? "",
    },
    headCommit: {
      message: head.message ?? "",
      author: {
        name: head.author?.name ?? "",
        email: head.author?.email ?? "",
      },
    },
    deliveryId: deliveryId ?? raw._deliveryId ?? raw.after ?? "",
    raw,
  };
}
