import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  rootReducer,
  sessionReducer,
  chatReducer,
  changesetReducer,
} from "@microsoft/agent-host-protocol";
import type {
  ActionOrigin,
  ChatAction,
  ChatState,
  RootAction,
  RootState,
  SessionAction,
  SessionState,
  ChangesetAction,
  ChangesetState,
} from "@microsoft/agent-host-protocol";
import {
  exchangeReducer,
  memoryReducer,
  executorReducer,
} from "./protocol/reducer.js";
import { Codes, requireThat } from "./protocol/errors.js";
import type {
  Envelope,
  ExchangeAction,
  ExchangeState,
  MemoryState,
  ExecutorRegistry,
  ChannelSnapshot,
} from "./protocol/types.js";
import { hash } from "./hash.js";

function reduce(
  resource: string,
  state: unknown,
  action: Envelope["action"],
): unknown {
  if (resource === "ahp-root://")
    return rootReducer(state as RootState, action as RootAction);
  if (resource.startsWith("ahp-session:/"))
    return sessionReducer(state as SessionState, action as SessionAction);
  if (resource.startsWith("ahp-chat:/"))
    return chatReducer(state as ChatState, action as ChatAction);
  if (resource.startsWith("ahp-changeset:/"))
    return changesetReducer(state as ChangesetState, action as ChangesetAction);
  if (resource === "axp-executors://")
    return executorReducer(state as ExecutorRegistry, action as ExchangeAction);
  if (resource === "axp-memory://")
    return memoryReducer(state as MemoryState, action as ExchangeAction);
  return exchangeReducer(state as ExchangeState, action as ExchangeAction);
}

/** A single synchronous transaction is the serialization point, including retry receipts. */
export class Store {
  readonly db: DatabaseSync;
  private readonly ownerLock: DatabaseSync | undefined;
  private writing = false;
  constructor(path = ":memory:") {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // A separate SQLite exclusive transaction is the process lifetime lock.
    // OS locks release on SIGKILL too: no stale PID files or lock stealing.
    if (path !== ":memory:") {
      this.ownerLock = new DatabaseSync(`${path}.lock`);
      chmodSync(`${path}.lock`, 0o600);
      try {
        this.ownerLock.exec(
          "PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner(id INTEGER); BEGIN EXCLUSIVE;",
        );
      } catch (error) {
        this.ownerLock.close();
        if (error instanceof Error && error.message.includes("locked"))
          throw new Error("Another AXP host owns this database", {
            cause: error,
          });
        throw error;
      }
    }
    let database: DatabaseSync | undefined;
    try {
      this.db = database = new DatabaseSync(path);
      requireThat(
        Number(this.db.prepare("PRAGMA user_version").get()?.user_version) <= 1,
        Codes.version,
        "Database was created by a newer AXP version",
      );
      if (path !== ":memory:") chmodSync(path, 0o600);
      this.db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS channels(resource TEXT PRIMARY KEY, state TEXT NOT NULL, seed TEXT NOT NULL, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, envelope TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_channel ON events(channel, seq);
      CREATE TABLE IF NOT EXISTS receipts(owner TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(owner,key));
      CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blobs(digest TEXT PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS blob_access(channel TEXT NOT NULL, digest TEXT NOT NULL REFERENCES blobs(digest), media_type TEXT NOT NULL, PRIMARY KEY(channel,digest));
      CREATE TABLE IF NOT EXISTS identity_keys(owner TEXT PRIMARY KEY, public_key TEXT NOT NULL);
      PRAGMA user_version=1;`);
    } catch (error) {
      database?.close();
      this.ownerLock?.close();
      throw error;
    }
  }
  get seq(): number {
    return Number(
      this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events").get()
        ?.seq,
    );
  }
  has(resource: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM channels WHERE resource=?")
      .get(resource);
  }
  get<T>(resource: string): T {
    const row = this.db
      .prepare("SELECT state FROM channels WHERE resource=?")
      .get(resource);
    requireThat(row, Codes.missing, "Unknown channel");
    return JSON.parse(String(row.state)) as T;
  }
  list(prefix: string): string[] {
    return this.db
      .prepare(
        "SELECT resource FROM channels WHERE resource LIKE ? ORDER BY resource",
      )
      .all(`${prefix}%`)
      .map((row) => String(row.resource));
  }
  snapshot(resource: string): ChannelSnapshot {
    return { resource, state: this.get(resource), fromSeq: this.seq };
  }
  events(
    channels: readonly string[],
    after = 0,
    through = this.seq,
  ): Envelope[] {
    if (!channels.length) return [];
    return this.db
      .prepare(
        `SELECT envelope FROM events WHERE seq>? AND seq<=? AND channel IN (${channels.map(() => "?").join(",")}) ORDER BY seq`,
      )
      .all(after, through, ...channels)
      .map((row) => JSON.parse(String(row.envelope)) as Envelope);
  }
  seeds(resources: readonly string[]): ChannelSnapshot[] {
    return resources.map((resource) => {
      const row = this.db
        .prepare("SELECT seed FROM channels WHERE resource=?")
        .get(resource);
      requireThat(row, Codes.missing, "Unknown channel");
      return JSON.parse(String(row.seed)) as ChannelSnapshot;
    });
  }
  bindClient(clientId: string, owner: string): void {
    const prior = this.db
      .prepare("SELECT owner FROM clients WHERE id=?")
      .get(clientId);
    requireThat(
      !prior || prior.owner === owner,
      Codes.forbidden,
      "Client identity belongs to another principal",
    );
    this.db
      .prepare("INSERT OR IGNORE INTO clients VALUES(?,?)")
      .run(clientId, owner);
  }
  bindKey(owner: string, publicKey: string): void {
    const prior = this.db
      .prepare("SELECT public_key FROM identity_keys WHERE owner=?")
      .get(owner);
    requireThat(
      !prior || prior.public_key === publicKey,
      Codes.forbidden,
      "Signing key does not match this principal",
    );
    this.db
      .prepare("INSERT OR IGNORE INTO identity_keys VALUES(?,?)")
      .run(owner, publicKey);
  }
  receipt(
    owner: string,
    key: string,
    fingerprint: string,
  ): { result: unknown } | null {
    const row = this.db
      .prepare(
        "SELECT fingerprint,result FROM receipts WHERE owner=? AND key=?",
      )
      .get(owner, key);
    if (!row) return null;
    requireThat(
      row.fingerprint === fingerprint,
      Codes.conflict,
      "Operation ID reused with different input",
    );
    return { result: JSON.parse(String(row.result)) as unknown };
  }
  transaction<T>(work: (tx: Transaction) => T): {
    result: T;
    events: Envelope[];
  } {
    requireThat(!this.writing, Codes.internal, "Nested transaction");
    this.writing = true;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const tx = new Transaction(this);
      const result = work(tx);
      requireThat(
        !(result instanceof Promise),
        Codes.internal,
        "Transactions must not await I/O",
      );
      this.db.exec("COMMIT");
      return { result, events: tx.events };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.writing = false;
    }
  }
  close(): void {
    try {
      this.db.close();
    } finally {
      this.ownerLock?.close();
    }
  }
}

export class Transaction {
  readonly events: Envelope[] = [];
  constructor(readonly store: Store) {}
  create(resource: string, state: unknown): void {
    requireThat(
      !this.store.has(resource),
      Codes.conflict,
      "Channel already exists",
    );
    const seq = this.store.seq;
    this.store.db
      .prepare("INSERT INTO channels VALUES(?,?,?,?)")
      .run(
        resource,
        JSON.stringify(state),
        JSON.stringify({ resource, state, fromSeq: seq }),
        seq,
      );
  }
  emit(
    channel: string,
    action: Envelope["action"],
    origin?: ActionOrigin,
  ): Envelope {
    const state = reduce(channel, this.store.get(channel), action);
    const row = this.store.db
      .prepare("INSERT INTO events(channel,envelope) VALUES(?,?)")
      .run(channel, "");
    const serverSeq = Number(row.lastInsertRowid);
    const envelope: Envelope = { channel, action, serverSeq, origin };
    this.store.db
      .prepare("UPDATE events SET envelope=? WHERE seq=?")
      .run(JSON.stringify(envelope), serverSeq);
    this.store.db
      .prepare("UPDATE channels SET state=?,seq=? WHERE resource=?")
      .run(JSON.stringify(state), serverSeq, channel);
    this.events.push(envelope);
    return envelope;
  }
  receipt(
    owner: string,
    key: string,
    fingerprint: string,
    result: unknown,
  ): void {
    this.store.db
      .prepare("INSERT INTO receipts VALUES(?,?,?,?)")
      .run(owner, key, fingerprint, JSON.stringify(result));
  }
  putBlob(channel: string, data: Uint8Array, mediaType: string) {
    const digest = hash(data);
    this.store.db
      .prepare("INSERT OR IGNORE INTO blobs VALUES(?,?)")
      .run(digest, data);
    this.store.db
      .prepare("INSERT OR IGNORE INTO blob_access VALUES(?,?,?)")
      .run(channel, digest, mediaType);
    return {
      uri: `axp-blob:/${encodeURIComponent(channel)}/${digest}`,
      sha256: digest,
      size: data.byteLength,
      mediaType,
    };
  }
}
