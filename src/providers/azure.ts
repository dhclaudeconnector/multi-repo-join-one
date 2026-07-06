import type { NormalizedPush } from "../types.js";
import { branchFromRef } from "./github.js";

/**
 * Normalize an Azure Repos `git.push` webhook payload into NormalizedPush.
 * Throws if required fields are missing.
 *
 * Mapping:
 *   ref        <- resource.refUpdates[0].name
 *   afterSha   <- resource.refUpdates[0].newObjectId
 *   beforeSha  <- resource.refUpdates[0].oldObjectId
 *   repo       <- resource.repository.name
 *   org        <- resource.repository.project.name
 *   cloneUrl   <- resource.repository.remoteUrl
 *   pusher     <- resource.pushedBy
 *   headCommit <- resource.commits[last]
 */
export function normalizeAzure(raw: any, deliveryId?: string): NormalizedPush {
  if (!raw || typeof raw !== "object") {
    throw new Error("azure: payload is not an object");
  }

  const resource = raw.resource;
  if (!resource || typeof resource !== "object") {
    throw new Error("azure: missing resource");
  }

  const repository = resource.repository;
  if (!repository || typeof repository.name !== "string") {
    throw new Error("azure: missing resource.repository.name");
  }

  const refUpdate = Array.isArray(resource.refUpdates)
    ? resource.refUpdates[0]
    : undefined;
  const ref: string = refUpdate?.name ?? "";
  if (!ref) throw new Error("azure: missing refUpdates[0].name");

  const afterSha: string = refUpdate?.newObjectId ?? "";
  if (!afterSha) throw new Error("azure: missing refUpdates[0].newObjectId");

  const org: string = repository.project?.name ?? "";
  const repo: string = repository.name;
  const fullName = org ? `${org}/${repo}` : repo;

  const commits = Array.isArray(resource.commits) ? resource.commits : [];
  const head = commits[commits.length - 1] ?? {};

  const pusherName: string =
    resource.pushedBy?.displayName ??
    resource.pushedBy?.uniqueName ??
    "";
  const pusherEmail: string =
    resource.pushedBy?.uniqueName ??
    head.author?.email ??
    "";

  const cloneUrl: string =
    repository.remoteUrl ??
    (org ? `https://dev.azure.com/${org}/_git/${repo}` : "");

  return {
    provider: "azure",
    org,
    repo,
    fullName,
    ref,
    branch: branchFromRef(ref),
    beforeSha: refUpdate?.oldObjectId ?? "",
    afterSha,
    cloneUrl,
    pusher: { name: pusherName, email: pusherEmail },
    headCommit: {
      message: head.comment ?? "",
      author: {
        name: head.author?.name ?? pusherName,
        email: head.author?.email ?? pusherEmail,
      },
    },
    deliveryId: deliveryId ?? raw._deliveryId ?? raw.id ?? afterSha,
    raw,
  };
}
