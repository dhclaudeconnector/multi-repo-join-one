import { promises as fs } from "node:fs";
import admin from "firebase-admin";
import type { QueueBackend } from "./backend.js";
import type { QueueItem, QueueItemStatus, TargetStatus } from "../types.js";

export interface RtdbConfig {
  dbUrl: string;
  queuePath: string;
  /** parsed service-account object, {__path: "..."} for a file, or undefined */
  serviceAccount?: Record<string, unknown>;
  /** distinct app name to allow multiple instances/tests */
  appName?: string;
  archiveDone?: boolean;
}

async function resolveCredential(
  sa: Record<string, unknown> | undefined
): Promise<admin.credential.Credential | undefined> {
  if (!sa) {
    // Rely on GOOGLE_APPLICATION_CREDENTIALS / emulator ADC.
    return undefined;
  }
  if (typeof sa.__path === "string") {
    const content = await fs.readFile(sa.__path, "utf8");
    return admin.credential.cert(JSON.parse(content));
  }
  return admin.credential.cert(sa as admin.ServiceAccount);
}

/**
 * Firebase RTDB queue backend. The GitHub/Azure webhook writes raw payloads
 * directly under `queuePath`; Firebase assigns chronologically-ordered push
 * keys. This backend subscribes to child_added and manages status transitions.
 */
export class RtdbQueueBackend implements QueueBackend {
  private app!: admin.app.App;
  private ref!: admin.database.Reference;
  private archiveRef!: admin.database.Reference;
  private cbs = new Map<
    (item: QueueItem) => void,
    (snap: admin.database.DataSnapshot) => void
  >();

  constructor(private cfg: RtdbConfig) {}

  static async create(cfg: RtdbConfig): Promise<RtdbQueueBackend> {
    const b = new RtdbQueueBackend(cfg);
    await b.init();
    return b;
  }

  private async init(): Promise<void> {
    const credential = await resolveCredential(this.cfg.serviceAccount);
    const appName = this.cfg.appName ?? `repo-sync-${Date.now()}`;
    this.app = admin.initializeApp(
      {
        databaseURL: this.cfg.dbUrl,
        ...(credential ? { credential } : {}),
      },
      appName
    );
    const db = this.app.database();
    const path = this.cfg.queuePath.replace(/^\/+/, "");
    this.ref = db.ref(path);
    this.archiveRef = db.ref(`${path}-archive`);
  }

  onChildAdded(handler: (item: QueueItem) => void): () => void {
    const cb = (snap: admin.database.DataSnapshot) => {
      const key = snap.key;
      if (!key) return;
      handler(this.toItem(key, snap.val()));
    };
    this.cbs.set(handler, cb);
    this.ref.on("child_added", cb);
    return () => {
      this.ref.off("child_added", cb);
      this.cbs.delete(handler);
    };
  }

  private toItem(key: string, val: any): QueueItem {
    if (val && typeof val === "object" && ("payload" in val || "status" in val)) {
      return { key, ...(val as object) } as QueueItem;
    }
    // raw webhook payload written directly by the hook
    return { key, payload: val, status: (val?.status as QueueItemStatus) ?? undefined };
  }

  async listAll(): Promise<QueueItem[]> {
    const snap = await this.ref.orderByKey().get();
    const out: QueueItem[] = [];
    snap.forEach((child) => {
      if (child.key) out.push(this.toItem(child.key, child.val()));
    });
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
  }

  async get(key: string): Promise<QueueItem | null> {
    const snap = await this.ref.child(key).get();
    if (!snap.exists()) return null;
    return this.toItem(key, snap.val());
  }

  async push(payload: unknown): Promise<string> {
    const child = this.ref.push();
    await child.set({ payload, status: "pending", createdAt: Date.now() });
    return child.key as string;
  }

  async setStatus(
    key: string,
    status: QueueItemStatus,
    patch: Partial<QueueItem> = {}
  ): Promise<void> {
    await this.ref.child(key).update({ ...patch, status, updatedAt: Date.now() });
  }

  async setTargetStatus(
    key: string,
    targetKey: string,
    status: TargetStatus
  ): Promise<void> {
    await this.ref
      .child(key)
      .child("targets")
      .child(encodeKey(targetKey))
      .set(status);
    await this.ref.child(key).update({ updatedAt: Date.now() });
  }

  async update(key: string, patch: Partial<QueueItem>): Promise<void> {
    await this.ref.child(key).update({ ...patch, updatedAt: Date.now() });
  }

  async remove(key: string): Promise<void> {
    if (this.cfg.archiveDone) {
      const snap = await this.ref.child(key).get();
      if (snap.exists()) {
        await this.archiveRef.child(key).set(snap.val());
      }
    }
    await this.ref.child(key).remove();
  }

  async close(): Promise<void> {
    for (const [, cb] of this.cbs) this.ref.off("child_added", cb);
    this.cbs.clear();
    await this.app.delete().catch(() => undefined);
  }
}

/** RTDB keys cannot contain . # $ [ ] / — encode target keys safely. */
function encodeKey(k: string): string {
  return k.replace(/[.#$/[\]]/g, "_");
}
