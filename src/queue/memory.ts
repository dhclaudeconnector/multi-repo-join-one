import type { QueueBackend } from "./backend.js";
import type { QueueItem, QueueItemStatus, TargetStatus } from "../types.js";
import { generatePushId } from "./pushId.js";

/**
 * In-memory queue backend that mimics RTDB ordering via Firebase-style push
 * keys. Used for unit/integration/smoke tests and for running without a live
 * Firebase connection.
 */
export class MemoryQueueBackend implements QueueBackend {
  private items = new Map<string, QueueItem>();
  private listeners = new Set<(item: QueueItem) => void>();
  private archive = new Map<string, QueueItem>();

  onChildAdded(handler: (item: QueueItem) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  async listAll(): Promise<QueueItem[]> {
    return [...this.items.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async get(key: string): Promise<QueueItem | null> {
    return this.items.get(key) ?? null;
  }

  async push(payload: unknown): Promise<string> {
    const key = generatePushId();
    const item: QueueItem = {
      key,
      payload,
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.items.set(key, item);
    // emit asynchronously to mimic RTDB child_added
    queueMicrotask(() => {
      for (const l of this.listeners) l({ ...item });
    });
    return key;
  }

  async setStatus(
    key: string,
    status: QueueItemStatus,
    patch: Partial<QueueItem> = {}
  ): Promise<void> {
    const item = this.items.get(key);
    if (!item) return;
    Object.assign(item, patch, { status, updatedAt: Date.now() });
  }

  async setTargetStatus(
    key: string,
    targetKey: string,
    status: TargetStatus
  ): Promise<void> {
    const item = this.items.get(key);
    if (!item) return;
    item.targets = { ...(item.targets ?? {}), [targetKey]: status };
    item.updatedAt = Date.now();
  }

  async update(key: string, patch: Partial<QueueItem>): Promise<void> {
    const item = this.items.get(key);
    if (!item) return;
    Object.assign(item, patch, { updatedAt: Date.now() });
  }

  async remove(key: string): Promise<void> {
    const item = this.items.get(key);
    if (item) {
      this.archive.set(key, item);
      this.items.delete(key);
    }
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }

  /* ---- test helpers ---- */
  getArchive(): QueueItem[] {
    return [...this.archive.values()];
  }
  snapshot(): QueueItem[] {
    return [...this.items.values()];
  }
}
