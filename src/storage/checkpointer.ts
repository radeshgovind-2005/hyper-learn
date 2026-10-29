import type { RunnableConfig } from "@langchain/core/runnables";
import {
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  MemorySaver,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";

// A LangGraph checkpointer that survives restarts: MemorySaver's logic, with each thread saved to a
// key-value store after every write and loaded back on first use. In the Worker the store is the
// Agent's SQLite, so a run paused at interrupt() (waiting for a human) can resume after the Durable
// Object was evicted. No Durable Object checkpointer ships with LangGraph.

/** Where threads are saved: one JSON string per thread id. */
export interface ThreadStore {
  get(threadId: string): string | undefined;
  set(threadId: string, json: string): void;
  delete(threadId: string): void;
}

export class MemoryThreadStore implements ThreadStore {
  readonly threads = new Map<string, string>();
  get(id: string) {
    return this.threads.get(id);
  }
  set(id: string, json: string) {
    this.threads.set(id, json);
  }
  delete(id: string) {
    this.threads.delete(id);
  }
}

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

type Stored = MemorySaver["storage"][string];
type Writes = MemorySaver["writes"];
interface SavedThread {
  storage: Record<string, Record<string, [string, string, string | undefined]>>;
  writes: Record<string, Record<string, [string, string, string, string?]>>;
}

const threadOf = (config: RunnableConfig) => config.configurable?.thread_id as string | undefined;
const writeKeyThread = (key: string) => (JSON.parse(key) as [string])[0];

export class PersistentMemorySaver extends MemorySaver {
  private readonly loaded = new Set<string>();

  constructor(private readonly threads: ThreadStore) {
    super();
  }

  /** Loads a thread from the store into memory, once. */
  private load(threadId: string | undefined) {
    if (threadId === undefined || this.loaded.has(threadId)) return;
    this.loaded.add(threadId);
    const json = this.threads.get(threadId);
    if (!json) return;
    const saved = JSON.parse(json) as SavedThread;
    const storage: Stored = {};
    for (const [ns, checkpoints] of Object.entries(saved.storage)) {
      storage[ns] = Object.fromEntries(
        Object.entries(checkpoints).map(([id, [checkpoint, metadata, parent]]) => [id, [fromBase64(checkpoint), fromBase64(metadata), parent]]),
      );
    }
    this.storage[threadId] = storage;
    for (const [key, writes] of Object.entries(saved.writes)) {
      this.writes[key] = Object.fromEntries(
        Object.entries(writes).map(([id, [task, channel, value, path]]) => [id, [task, channel, fromBase64(value), ...(path === undefined ? [] : [path])]]),
      ) as Writes[string];
    }
  }

  /** Saves a thread from memory to the store. */
  private save(threadId: string | undefined) {
    if (threadId === undefined) return;
    const saved: SavedThread = { storage: {}, writes: {} };
    for (const [ns, checkpoints] of Object.entries(this.storage[threadId] ?? {})) {
      saved.storage[ns] = Object.fromEntries(
        Object.entries(checkpoints).map(([id, [checkpoint, metadata, parent]]) => [id, [toBase64(checkpoint), toBase64(metadata), parent]]),
      );
    }
    for (const [key, writes] of Object.entries(this.writes)) {
      if (writeKeyThread(key) !== threadId) continue;
      saved.writes[key] = Object.fromEntries(
        Object.entries(writes).map(([id, [task, channel, value, path]]) => [id, [task, channel, toBase64(value), ...(path === undefined ? [] : [path])]]),
      ) as SavedThread["writes"][string];
    }
    this.threads.set(threadId, JSON.stringify(saved));
  }

  override async getTuple(config: RunnableConfig) {
    this.load(threadOf(config));
    return super.getTuple(config);
  }

  override async *list(config: RunnableConfig, options?: CheckpointListOptions) {
    this.load(threadOf(config));
    yield* super.list(config, options);
  }

  override async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata) {
    this.load(threadOf(config));
    const next = await super.put(config, checkpoint, metadata);
    this.save(threadOf(config));
    return next;
  }

  override async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath?: string) {
    this.load(threadOf(config));
    await super.putWrites(config, writes, taskId, taskPath);
    this.save(threadOf(config));
  }

  override async deleteThread(threadId: string) {
    await super.deleteThread(threadId);
    this.loaded.delete(threadId);
    this.threads.delete(threadId);
  }
}
