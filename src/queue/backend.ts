import type { QueueItem, QueueItemStatus, TargetStatus } from "../types.js";

/**
 * Abstraction over the durable queue store. The RTDB implementation is the
 * production backend; an in-memory implementation is used for tests/smoke and
 * to run without a live Firebase connection.
 */
export interface QueueBackend {
  /**
   * Subscribe to newly added queue items (child_added). Returns an unsubscribe
   * function. Handler receives the item as written (payload + any status).
   */
  onChildAdded(handler: (item: QueueItem) => void): () => void;

  /** Read all queue items currently present, ordered by key ascending. */
  listAll(): Promise<QueueItem[]>;

  /** Read a single item by key (or null). */
  get(key: string): Promise<QueueItem | null>;

  /** Push a raw payload, returning the generated ordered key (like RTDB push). */
  push(payload: unknown): Promise<string>;

  /** Patch status/reason/timestamps on an item. */
  setStatus(
    key: string,
    status: QueueItemStatus,
    patch?: Partial<QueueItem>
  ): Promise<void>;

  /** Set per-target status on an item. */
  setTargetStatus(
    key: string,
    targetKey: string,
    status: TargetStatus
  ): Promise<void>;

  /** Merge arbitrary fields into an item. */
  update(key: string, patch: Partial<QueueItem>): Promise<void>;

  /** Remove an item (or archive, backend's choice). */
  remove(key: string): Promise<void>;

  /** Release resources. */
  close(): Promise<void>;
}
