import Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import {
  BridgeError,
  allowed,
  coverage,
  eventSchema,
  healthSchema,
  readSchema,
  sanitizeText,
  sourceLink,
  type Source,
  type Principal,
  type ReadInput,
  type Observation,
} from "../../domain/src/index.js";
import type { Config } from "./config.js";
type Row = {
  rowid: number;
  source: string;
  conv: string;
  id: string;
  created: number;
  revision: number;
  observed: number;
  author: string | null;
  text: string | null;
  deleted: number;
};
type Change = {
  seq: number;
  source: string;
  conv: string;
  id: string;
  op: string;
  at: number;
};
type Cursor = {
  subject: string;
  kind: string;
  filter: string;
  epoch: number;
  expires: number;
  snapshot: number;
  position: number;
};
export class Store {
  db: Database.Database;
  private retention: number;
  constructor(
    public config: Config,
    private now = Date.now,
  ) {
    if (config.database !== ":memory:") {
      mkdirSync(dirname(config.database), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(config.database);
    if (config.database !== ":memory:") chmodSync(config.database, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("secure_delete = ON");
    this.retention = config.retentionDays * 86400000;
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS meta(epoch INTEGER NOT NULL);INSERT INTO meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM meta);
 CREATE TABLE IF NOT EXISTS messages(key INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT,conv TEXT,id TEXT,created INTEGER,revision INTEGER,observed INTEGER,author TEXT,text TEXT,deleted INTEGER, UNIQUE(source,conv,id));
 CREATE INDEX IF NOT EXISTS message_order ON messages(source,conv,created,id);
 CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT,conv TEXT,id TEXT,op TEXT,at INTEGER);
 CREATE TABLE IF NOT EXISTS seen(source TEXT,event TEXT,conv TEXT,hash TEXT,at INTEGER,PRIMARY KEY(source,event));
 CREATE TABLE IF NOT EXISTS watermark(floor INTEGER NOT NULL);INSERT INTO watermark SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM watermark);
 CREATE TABLE IF NOT EXISTS health(source TEXT PRIMARY KEY,json TEXT,received INTEGER);
 CREATE TABLE IF NOT EXISTS cursors(id TEXT PRIMARY KEY,subject TEXT,kind TEXT,filter TEXT,epoch INTEGER,expires INTEGER,snapshot INTEGER,position INTEGER);`);
    // Existing persisted revocations win over startup configuration. Widening needs the local apply-scopes command.
    for (const source of config.sources) {
      this.db
        .prepare("INSERT OR IGNORE INTO sources VALUES (?,?)")
        .run(source.id, JSON.stringify(source));
    }
    for (const source of this.sources()) {
      const cfg = config.sources.find((s) => s.id === source.id);
      if (
        !cfg ||
        (!cfg.enabled && source.enabled) ||
        cfg.type !== source.type ||
        cfg.accountId !== source.accountId ||
        source.conversations.some(
          (v) =>
            !cfg.conversations.some(
              (c) => c.id === v.id && c.guildId === v.guildId,
            ),
        )
      ) {
        this.controlInternal(source.id, "revoke");
      }
    }
    this.sweep();
  }
  close() {
    this.db.close();
  }
  sources(): Source[] {
    return (
      this.db.prepare("SELECT json FROM sources ORDER BY id").all() as {
        json: string;
      }[]
    ).map((r) => JSON.parse(r.json));
  }
  private epoch() {
    return (
      this.db.prepare("SELECT epoch FROM meta").get() as { epoch: number }
    ).epoch;
  }
  private invalidate() {
    this.db.exec("UPDATE meta SET epoch=epoch+1;DELETE FROM cursors;");
  }
  private assert(p: Principal, role: Principal["role"]) {
    if (p.ownerId !== this.config.ownerId || p.role !== role)
      throw new BridgeError("forbidden", 403);
  }
  private visible(p: Principal, source: string, conv?: string) {
    const s = this.sources().find((v) => v.id === source);
    return (
      !!s?.enabled &&
      p.sourceIds.includes(source) &&
      (!conv ||
        (s.conversations.some((v) => v.id === conv) &&
          (!p.conversationIds || p.conversationIds.includes(conv))))
    );
  }
  producerScope(p: Principal) {
    this.assert(p, "producer");
    return {
      conversationScopeComplete: p.conversationIds === undefined,
      sources: this.sources()
        .filter((s) => p.sourceIds.includes(s.id))
        .map((s) => ({
          ...s,
          conversations: s.conversations.filter(
            (c) => !p.conversationIds || p.conversationIds.includes(c.id),
          ),
        })),
    };
  }
  ingest(p: Principal, inputs: unknown[], health?: unknown) {
    this.assert(p, "producer");
    if (inputs.length > 100) throw new BridgeError("batch_limit");
    this.sweep();
    const events = inputs.map((e) => eventSchema.parse(e));
    const h = health === undefined ? undefined : healthSchema.parse(health);
    const validate = (e: {
      sourceId: string;
      accountId: string;
      generation: number;
      conversationId?: string;
    }) => {
      const s = this.sources().find((s) => s.id === e.sourceId);
      if (
        !s ||
        !p.sourceIds.includes(s.id) ||
        !s.enabled ||
        s.accountId !== e.accountId ||
        s.generation !== e.generation ||
        (e.conversationId &&
          (!allowed(s, e.accountId, e.conversationId, e.generation) ||
            !this.visible(p, s.id, e.conversationId)))
      )
        throw new BridgeError("scope_denied", 403);
    };
    let accepted = 0;
    this.db
      .transaction(() => {
        events.forEach(validate);
        if (h) validate(h);
        for (const e of events) {
          if (
            e.observedAt > this.now() + 60000 ||
            e.revision > this.now() + 60000 ||
            e.observedAt < this.now() - this.retention
          )
            throw new BridgeError("observation_window");
          if (
            e.op === "upsert" &&
            (e.createdAt < this.now() - this.retention ||
              e.createdAt > this.now() + 60000 ||
              e.revision < e.createdAt)
          )
            continue;
          const hash = createHash("sha256")
            .update(JSON.stringify(e))
            .digest("hex");
          const seen = this.db
            .prepare("SELECT hash FROM seen WHERE source=? AND event=?")
            .get(e.sourceId, e.eventId) as { hash: string } | undefined;
          if (seen) {
            if (seen.hash !== hash)
              throw new BridgeError("event_collision", 409);
            continue;
          }
          this.db
            .prepare("INSERT INTO seen VALUES (?,?,?,?,?)")
            .run(e.sourceId, e.eventId, e.conversationId, hash, this.now());
          const old = this.row(e.sourceId, e.conversationId, e.messageId);
          if (
            old?.deleted === 1 ||
            (old && e.op !== "delete" && old.revision >= e.revision)
          )
            continue;
          this.apply(e, old);
          accepted++;
        }
        if (h)
          this.db
            .prepare("INSERT OR REPLACE INTO health VALUES (?,?,?)")
            .run(h.sourceId, JSON.stringify(h), this.now());
      })
      .immediate();
    return { accepted };
  }
  private row(source: string, conv: string, id: string) {
    return this.db
      .prepare(
        "SELECT rowid AS rowid,* FROM messages WHERE source=? AND conv=? AND id=?",
      )
      .get(source, conv, id) as Row | undefined;
  }
  private change(source: string, conv: string, id: string, op: string) {
    this.db
      .prepare("INSERT INTO changes(source,conv,id,op,at) VALUES (?,?,?,?,?)")
      .run(source, conv, id, op, this.now());
  }
  private apply(e: Observation, old?: Row) {
    const deleted = e.op === "delete";
    this.db
      .prepare(
        `INSERT INTO messages(source,conv,id,created,revision,observed,author,text,deleted) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(source,conv,id) DO UPDATE SET created=excluded.created,revision=excluded.revision,observed=excluded.observed,author=excluded.author,text=excluded.text,deleted=excluded.deleted`,
      )
      .run(
        e.sourceId,
        e.conversationId,
        e.messageId,
        deleted ? (old?.created ?? e.observedAt) : e.createdAt,
        e.revision,
        e.observedAt,
        deleted ? null : e.authorId,
        deleted ? null : sanitizeText(e.text),
        deleted ? (e.reason === "unavailable_edit" ? 2 : 1) : 0,
      );
    this.change(e.sourceId, e.conversationId, e.messageId, e.op);
  }
  sweep() {
    const cutoff = this.now() - this.retention;
    this.db.transaction(() => {
      const stale = this.db
        .prepare(
          "SELECT rowid AS rowid,* FROM messages WHERE deleted=0 AND created<?",
        )
        .all(cutoff) as Row[];
      for (const row of stale) {
        this.db
          .prepare(
            "UPDATE messages SET deleted=1,text=NULL,author=NULL,observed=? WHERE rowid=?",
          )
          .run(this.now(), row.rowid);
        this.change(row.source, row.conv, row.id, "delete");
      }
      this.db
        .prepare("DELETE FROM messages WHERE deleted>0 AND observed<?")
        .run(cutoff);
      this.db
        .prepare(
          "UPDATE watermark SET floor=MAX(floor,(SELECT COALESCE(MAX(seq),0) FROM changes WHERE at<?))",
        )
        .run(cutoff);
      this.db.prepare("DELETE FROM changes WHERE at<?").run(cutoff);
      this.db.prepare("DELETE FROM seen WHERE at<?").run(cutoff);
      this.db.prepare("DELETE FROM cursors WHERE expires<?").run(this.now());
    })();
  }
  private controlInternal(
    sourceId: string,
    action: "purge" | "revoke",
    conversationId?: string,
  ) {
    return this.db
      .transaction(() => {
        const source = this.sources().find((v) => v.id === sourceId);
        if (!source) throw new BridgeError("scope_denied", 403);
        source.generation++;
        if (action === "revoke") {
          if (conversationId)
            source.conversations = source.conversations.filter(
              (v) => v.id !== conversationId,
            );
          else source.enabled = false;
        }
        this.db
          .prepare("UPDATE sources SET json=? WHERE id=?")
          .run(JSON.stringify(source), source.id);
        // Purge content immediately; deletion events remain content-free for permitted readers.
        const rows = this.db
          .prepare("SELECT rowid AS rowid,* FROM messages WHERE source=?")
          .all(source.id) as Row[];
        for (const row of rows) {
          if (conversationId && row.conv !== conversationId) continue;
          this.db
            .prepare(
              "UPDATE messages SET text=NULL,author=NULL,deleted=1,observed=? WHERE rowid=?",
            )
            .run(this.now(), row.rowid);
          this.change(source.id, row.conv, row.id, "delete");
        }
        this.db.prepare("DELETE FROM seen WHERE source=?").run(source.id);
        this.db.prepare("DELETE FROM health WHERE source=?").run(source.id);
        this.invalidate();
        return { source };
      })
      .immediate();
  }
  private controlChecked(
    p: Principal,
    input: {
      sourceId: string;
      accountId: string;
      generation: number;
      action: "purge" | "revoke";
      conversationId?: string;
    },
  ) {
    this.assert(p, "producer");
    const source = this.sources().find((v) => v.id === input.sourceId);
    if (
      !source ||
      !p.sourceIds.includes(source.id) ||
      source.accountId !== input.accountId ||
      source.generation !== input.generation ||
      (input.conversationId &&
        (!source.conversations.some((v) => v.id === input.conversationId) ||
          (p.conversationIds &&
            !p.conversationIds.includes(input.conversationId)))) ||
      (!input.conversationId && p.conversationIds)
    )
      throw new BridgeError("scope_denied", 403);
    return this.controlInternal(source.id, input.action, input.conversationId);
  }
  control(p: Principal, input: Parameters<Store["controlChecked"]>[1]) {
    return this.db.transaction(() => this.controlChecked(p, input)).immediate();
  }
  applyScopes(sources: Source[]) {
    this.db
      .transaction(() => {
        for (let source of sources) {
          const old = this.sources().find((s) => s.id === source.id);
          if (old) this.controlInternal(source.id, "purge");
          source = {
            ...source,
            generation: old
              ? Math.max(old.generation + 1, source.generation)
              : source.generation,
          };
          this.db
            .prepare("INSERT OR REPLACE INTO sources VALUES (?,?)")
            .run(source.id, JSON.stringify(source));
        }
        for (const old of this.sources())
          if (!sources.some((s) => s.id === old.id))
            this.controlInternal(old.id, "revoke");
        this.invalidate();
      })
      .immediate();
  }
  execute(p: Principal, operation: string, input: ReadInput = {}) {
    return this.db
      .transaction(() => this.executeInternal(p, operation, input))
      .immediate();
  }
  private executeInternal(
    p: Principal,
    operation: string,
    input: ReadInput = {},
  ) {
    this.assert(p, "reader");
    this.sweep();
    const args = readSchema.parse(input);
    if (args.sourceId && !this.visible(p, args.sourceId, args.conversationId))
      throw new BridgeError("scope_denied", 403);
    if (args.conversationId && !args.sourceId)
      throw new BridgeError("source_required");
    const sources = this.sources().filter((s) => this.visible(p, s.id));
    if (operation === "connection_status")
      return {
        sources: this.sources()
          .filter((s) => p.sourceIds.includes(s.id))
          .map((s) => {
            const r = this.db
              .prepare("SELECT json,received FROM health WHERE source=?")
              .get(s.id) as { json: string; received: number } | undefined;
            const h = r ? JSON.parse(r.json) : null;
            return {
              id: s.id,
              type: s.type,
              enabled: s.enabled,
              accountId: s.accountId,
              generation: s.generation,
              conversations: s.conversations.filter((v) =>
                this.visible(p, s.id, v.id),
              ),
              freshAt: r?.received ?? null,
              stale: !r || this.now() - r.received > 60000,
              health: h,
            };
          }),
        retentionDays: this.config.retentionDays,
        coverage,
      };
    if (operation === "list_conversations")
      return {
        conversations: sources.flatMap((s) =>
          s.conversations
            .filter(
              (c) => !p.conversationIds || p.conversationIds.includes(c.id),
            )
            .map((c) => ({
              ...c,
              sourceId: s.id,
              sourceType: s.type,
              accountId: s.accountId,
            })),
        ),
        coverage,
      };
    if (!["read_messages", "search", "read_changes"].includes(operation))
      throw new BridgeError("operation_unknown", 404);
    if (operation === "search" && !args.query)
      throw new BridgeError("query_required");
    const filter = JSON.stringify({
      sourceId: args.sourceId,
      conversationId: args.conversationId,
      query: args.query,
      scope: p.sourceIds,
      conversations: p.conversationIds,
    });
    const kind = operation;
    let c: Cursor;
    if (args.cursor) {
      const row = this.db
        .prepare("SELECT * FROM cursors WHERE id=?")
        .get(args.cursor) as Cursor | undefined;
      if (
        !row ||
        row.subject !== p.subject ||
        row.kind !== kind ||
        row.filter !== filter ||
        row.epoch !== this.epoch() ||
        row.expires < this.now()
      )
        throw new BridgeError("cursor_expired_resync", 410);
      c = row;
    } else
      c = {
        subject: p.subject,
        kind,
        filter,
        epoch: this.epoch(),
        expires: this.now() + this.config.cursorTtlSeconds * 1000,
        snapshot:
          kind === "read_changes"
            ? 0
            : (
                this.db
                  .prepare("SELECT COALESCE(MAX(rowid),0) n FROM messages")
                  .get() as { n: number }
              ).n,
        position: 0,
      };
    // SQL scope clauses prevent unrelated content being loaded into application memory.
    const clauses = ["(0"];
    const values: unknown[] = [];
    for (const s of sources) {
      const selected = s.conversations
        .filter((c) => !p.conversationIds || p.conversationIds.includes(c.id))
        .map((c) => c.id);
      if (selected.length) {
        clauses.push(
          `OR (source=? AND conv IN (${selected.map(() => "?").join(",")}))`,
        );
        values.push(s.id, ...selected);
      }
    }
    clauses.push(")");
    if (args.sourceId) {
      clauses.push("AND source=?");
      values.push(args.sourceId);
    }
    if (args.conversationId) {
      clauses.push("AND conv=?");
      values.push(args.conversationId);
    }
    let items: unknown[];
    let position = c.position;
    let hasMore = false;
    if (kind === "read_changes") {
      const floor = (
        this.db.prepare("SELECT floor FROM watermark").get() as {
          floor: number;
        }
      ).floor;
      if (args.cursor && c.position < floor)
        throw new BridgeError("cursor_expired_resync", 410);
      const max = (
        this.db
          .prepare(
            "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='changes'),0) n",
          )
          .get() as { n: number }
      ).n;
      const snapshot = c.snapshot || max;
      const rows = this.db
        .prepare(
          `SELECT * FROM changes WHERE ${clauses.join(" ")} AND seq>? AND seq<=? ORDER BY seq LIMIT ?`,
        )
        .all(...values, c.position, snapshot, args.limit + 1) as Change[];
      hasMore = rows.length > args.limit;
      const page = rows.slice(0, args.limit);
      position = page.at(-1)?.seq ?? snapshot;
      items = page.map((r) => {
        const message = this.row(r.source, r.conv, r.id);
        return {
          sequence: r.seq,
          sourceId: r.source,
          conversationId: r.conv,
          messageId: r.id,
          op: message && !message.deleted ? "upsert" : "delete",
          changedAt: r.at,
          reason: message?.deleted === 2 ? "unavailable_edit" : undefined,
          message:
            message && !message.deleted ? this.present(message) : undefined,
        };
      });
      c.snapshot = hasMore ? snapshot : 0;
      if (!hasMore) position = snapshot;
    } else {
      if (args.query) {
        clauses.push("AND instr(lower(text),lower(?))>0");
        values.push(args.query);
      }
      // Persistent rowid gives a stable insertion-order traversal; edits do not move entries.
      const rows = this.db
        .prepare(
          `SELECT rowid AS rowid,* FROM messages WHERE ${clauses.join(" ")} AND deleted=0 AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?`,
        )
        .all(...values, c.position, c.snapshot, args.limit + 1) as Row[];
      hasMore = rows.length > args.limit;
      const page = rows.slice(0, args.limit);
      position = page.at(-1)?.rowid ?? c.position;
      items = page.map((r) => this.present(r));
    }
    let cursor: string | null = null;
    if (hasMore || kind === "read_changes") {
      cursor = randomUUID();
      c.position = position;
      // Bound cursor resource use per authenticated principal.
      this.db
        .prepare(
          "DELETE FROM cursors WHERE id IN (SELECT id FROM cursors WHERE subject=? ORDER BY expires DESC LIMIT -1 OFFSET 199)",
        )
        .run(p.subject);
      this.db
        .prepare("INSERT INTO cursors VALUES (?,?,?,?,?,?,?,?)")
        .run(
          cursor,
          c.subject,
          c.kind,
          c.filter,
          c.epoch,
          c.expires,
          c.snapshot,
          c.position,
        );
    }
    return { items, cursor, hasMore, coverage, asOf: this.now() };
  }
  private present(row: Row) {
    const source = this.sources().find((s) => s.id === row.source)!;
    return {
      sourceId: source.id,
      sourceType: source.type,
      accountId: source.accountId,
      conversationId: row.conv,
      messageId: row.id,
      createdAt: row.created,
      revision: row.revision,
      observedAt: row.observed,
      authorId: row.author,
      text: row.text,
      url: sourceLink(source, row.conv, row.id),
      untrusted: true,
    };
  }
}
