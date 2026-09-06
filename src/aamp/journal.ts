import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { AampMail, AampReply, AampRequest } from "./wire.js";

export interface MailTask {
  key: string;
  request: AampRequest;
  channel: string;
  status: "queued" | "running" | "completed" | "rejected" | "cancelled";
  turnId: string;
  startedAt: string;
  cancelRequested: boolean;
}

/** A single process owns each journal. Cursor advancement and inbox writes are atomic. */
export class AampJournal {
  readonly db: DatabaseSync;
  private readonly lock: DatabaseSync | undefined;
  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      this.lock = new DatabaseSync(`${path}.lock`);
      chmodSync(`${path}.lock`, 0o600);
      try {
        this.lock.exec(
          "PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner(id); BEGIN EXCLUSIVE;",
        );
      } catch (error) {
        this.lock.close();
        throw new Error("Another AAMP adapter owns this journal", {
          cause: error,
        });
      }
    }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path);
      this.db = db;
      if (path !== ":memory:") chmodSync(path, 0o600);
      const version = Number(
        db.prepare("PRAGMA user_version").get()?.user_version,
      );
      if (version > 1)
        throw new Error(`Unsupported AAMP journal version ${version}`);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY, mail TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE TABLE IF NOT EXISTS tasks(key TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, task_key TEXT NOT NULL, reply TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(processed);
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(sent);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(json_extract(state,'$.status'));
      PRAGMA user_version=1;
    `);
    } catch (error) {
      db?.close();
      this.lock?.close();
      throw error;
    }
  }
  setting(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key);
    return row ? String(row.value) : null;
  }
  set(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
      .run(key, value);
  }
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  receive(mail: AampMail[], cursor: string): void {
    this.transaction(() => {
      for (const message of mail)
        this.db
          .prepare("INSERT OR IGNORE INTO inbox(id,mail) VALUES(?,?)")
          .run(message.id, JSON.stringify(message));
      this.set("cursor", cursor);
    });
  }
  pending(): AampMail[] {
    return this.db
      .prepare(
        "SELECT mail FROM inbox WHERE processed=0 ORDER BY rowid LIMIT 128",
      )
      .all()
      .map((r) => JSON.parse(String(r.mail)) as AampMail);
  }
  processed(id: string, error?: string): void {
    this.db
      .prepare("UPDATE inbox SET processed=1,error=? WHERE id=?")
      .run(error?.slice(0, 1000) ?? null, id);
  }
  admitMessage(id: string, fingerprint: string): boolean {
    const prior = this.db
      .prepare("SELECT fingerprint FROM deliveries WHERE id=?")
      .get(id);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new Error("Message-ID reused with different input");
      return false;
    }
    this.db.prepare("INSERT INTO deliveries VALUES(?,?)").run(id, fingerprint);
    return true;
  }
  task(key: string): MailTask | null {
    const row = this.db.prepare("SELECT state FROM tasks WHERE key=?").get(key);
    return row ? (JSON.parse(String(row.state)) as MailTask) : null;
  }
  active(): MailTask[] {
    return this.db
      .prepare(
        "SELECT state FROM tasks WHERE json_extract(state,'$.status') IN ('queued','running') ORDER BY rowid",
      )
      .all()
      .map((r) => JSON.parse(String(r.state)) as MailTask);
  }
  save(task: MailTask): void {
    this.db
      .prepare(
        "INSERT INTO tasks VALUES(?,?) ON CONFLICT(key) DO UPDATE SET state=excluded.state",
      )
      .run(task.key, JSON.stringify(task));
  }
  reply(key: string, taskKey: string, reply: AampReply): void {
    this.db
      .prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,0)")
      .run(key, taskKey, JSON.stringify(reply));
  }
  outbox(): { id: string; taskKey: string; reply: AampReply }[] {
    return this.db
      .prepare("SELECT * FROM outbox WHERE sent=0 ORDER BY rowid LIMIT 128")
      .all()
      .map((r) => ({
        id: String(r.id),
        taskKey: String(r.task_key),
        reply: JSON.parse(String(r.reply)) as AampReply,
      }));
  }
  sent(id: string): void {
    this.db.prepare("UPDATE outbox SET sent=1 WHERE id=?").run(id);
  }
  suppress(taskKey: string): void {
    this.db
      .prepare("DELETE FROM outbox WHERE task_key=? AND sent=0")
      .run(taskKey);
  }
  close(): void {
    try {
      this.db.close();
    } finally {
      this.lock?.close();
    }
  }
}
