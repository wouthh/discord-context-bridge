import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/service/src/store.js";
import { config, event, now, reader, producer, source } from "./fixtures.js";
import { BridgeError } from "../packages/domain/src/index.js";
const page = (s: Store, op = "read_messages", input = {}) =>
  s.execute(reader, op, input) as {
    items: { text?: string; message?: { text: string }; op?: string }[];
    cursor: string | null;
    hasMore: boolean;
  };
test("ingestion, duplicate delivery, edit, delayed history and irreversible observed deletion", () => {
  const s = new Store(config(), () => now);
  try {
    assert.equal(s.ingest(producer, [event()]).accepted, 1);
    assert.equal(s.ingest(producer, [event()]).accepted, 0);
    assert.equal(
      s.ingest(producer, [
        event({
          eventId: "edit",
          revision: now,
          text: "Synthetic edited text",
        }),
      ]).accepted,
      1,
    );
    assert.equal(
      s.ingest(producer, [
        event({ eventId: "late", text: "Synthetic stale text" }),
      ]).accepted,
      0,
    );
    assert.equal(page(s).items[0].text, "Synthetic edited text");
    s.ingest(
      producer,
      [
        event({
          eventId: "delete",
          op: "delete",
          sourceId: source.id,
          accountId: source.accountId,
          conversationId: "selected-a",
          messageId: "synthetic-message",
          observedAt: now,
          revision: now,
        }),
      ].map((e) => {
        if (e.op !== "delete") return e;
        const {
          text: _,
          authorId: __,
          createdAt: ___,
          ...clean
        } = e as unknown as Record<string, unknown>;
        return clean;
      }),
    );
    assert.equal(page(s).items.length, 0);
    s.ingest(producer, [event({ eventId: "resurrect", revision: now + 1 })]);
    assert.equal(page(s).items.length, 0);
    const changes = page(s, "read_changes");
    assert(changes.items.every((c) => c.op === "delete" && !c.message));
    const stored = s.db.prepare("SELECT text,author FROM messages").get();
    assert.deepEqual(stored, { text: null, author: null });
  } finally {
    s.close();
  }
});
test("capture-independent ingestion and reader allowlists, owners, accounts, roles and batch atomicity", () => {
  const s = new Store(config(), () => now);
  try {
    for (const e of [
      event({ accountId: "other-account" }),
      event({ conversationId: "excluded" }),
      event({ generation: 2 }),
      event({ sourceId: "other-source" }),
    ])
      assert.throws(() => s.ingest(producer, [e]), { code: "scope_denied" });
    assert.throws(() => s.ingest(reader, [event()]), { code: "forbidden" });
    assert.throws(
      () => s.execute({ ...reader, ownerId: "other" }, "read_messages"),
      { code: "forbidden" },
    );
    assert.throws(() =>
      s.ingest(producer, [
        event(),
        event({ eventId: "excluded", conversationId: "excluded" }),
      ]),
    );
    assert.equal(page(s).items.length, 0);
    s.ingest(producer, [
      event(),
      event({ eventId: "b", conversationId: "selected-b", messageId: "b" }),
    ]);
    const restricted = { ...reader, conversationIds: ["selected-a"] };
    const result = s.execute(restricted, "read_messages") as {
      items: unknown[];
    };
    assert.equal(result.items.length, 1);
    assert.throws(
      () =>
        s.execute(restricted, "read_messages", {
          sourceId: source.id,
          conversationId: "selected-b",
        }),
      { code: "scope_denied" },
    );
    assert.throws(
      () =>
        s.execute({ ...reader, sourceIds: [] }, "read_messages", {
          sourceId: source.id,
        }),
      { code: "scope_denied" },
    );
  } finally {
    s.close();
  }
});
test("purge/revoke invalidates generation and cursors; revoked scopes survive restart and explicit reconfiguration", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-store-"));
  const file = join(dir, "store.sqlite");
  let s = new Store(config(file), () => now);
  try {
    s.ingest(producer, [event()]);
    const cursor = page(s, "read_changes").cursor!;
    s.control(producer, {
      sourceId: source.id,
      accountId: source.accountId,
      generation: 1,
      action: "revoke",
      conversationId: "selected-a",
    });
    assert.throws(() => s.ingest(producer, [event()]), {
      code: "scope_denied",
    });
    assert.throws(() => page(s, "read_changes", { cursor }), {
      code: "cursor_expired_resync",
    });
    assert.equal(page(s).items.length, 0);
    s.close();
    s = new Store(config(file), () => now);
    assert(!s.sources()[0].conversations.some((c) => c.id === "selected-a"));
    assert.throws(() => s.ingest(producer, [event()]), {
      code: "scope_denied",
    });
    s.applyScopes([source]);
    assert.equal(s.sources()[0].generation, 3);
    assert.equal(statSync(file).mode & 0o077, 0);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("stable insertion cursor excludes new arrivals and expiry requires bounded resync", () => {
  let clock = now;
  const s = new Store(config(), () => clock);
  try {
    s.ingest(producer, [
      event({ eventId: "a", messageId: "a" }),
      event({ eventId: "b", messageId: "b" }),
    ]);
    const first = page(s, "read_messages", { limit: 1 });
    assert(first.cursor);
    s.ingest(producer, [
      event({ eventId: "c", messageId: "c" }),
      event({
        eventId: "edit",
        messageId: "b",
        revision: now,
        text: "Synthetic updated b",
      }),
    ]);
    const second = page(s, "read_messages", { limit: 1, cursor: first.cursor });
    assert.equal(second.items.length, 1);
    assert.equal(second.items[0].text, "Synthetic updated b");
    assert.equal(second.cursor, null);
    assert.throws(
      () => page(s, "search", { query: "Synthetic", cursor: first.cursor }),
      { code: "cursor_expired_resync" },
    );
    clock += 901000;
    assert.throws(
      () => page(s, "read_messages", { limit: 1, cursor: first.cursor }),
      { code: "cursor_expired_resync" },
    );
  } finally {
    s.close();
  }
});
test("incremental checkpoint excludes arrivals during a page and catches them on next poll", () => {
  const s = new Store(config(), () => now);
  try {
    s.ingest(producer, [
      event({ eventId: "a", messageId: "a" }),
      event({ eventId: "b", messageId: "b" }),
    ]);
    const a = page(s, "read_changes", { limit: 1 });
    s.ingest(producer, [event({ eventId: "c", messageId: "c" })]);
    const b = page(s, "read_changes", { limit: 1, cursor: a.cursor });
    assert.equal(b.items.length, 1);
    const c = page(s, "read_changes", { limit: 1, cursor: b.cursor });
    assert.equal(c.items.length, 1);
    assert(!c.hasMore);
  } finally {
    s.close();
  }
});
test("retention removes bodies, secrets filter is defense in depth and stale/future observation rejected", () => {
  let clock = now;
  const s = new Store(config(), () => clock);
  try {
    const secret = "ghp_" + "x".repeat(30);
    s.ingest(producer, [event({ text: `Synthetic ${secret}` })]);
    assert.equal(page(s).items[0].text, "Synthetic [potential secret removed]");
    assert.throws(
      () =>
        s.ingest(producer, [
          event({ eventId: "future", observedAt: now + 120000 }),
        ]),
      { code: "observation_window" },
    );
    assert.equal(
      s.ingest(producer, [
        event({
          eventId: "old",
          createdAt: now - 8 * 86400000,
          revision: now - 8 * 86400000,
        }),
      ]).accepted,
      0,
    );
    clock += 7 * 86400000;
    s.sweep();
    assert.equal(page(s).items.length, 0);
    const rows = s.db.prepare("SELECT text FROM messages").all() as {
      text: null;
    }[];
    assert(rows.every((v) => v.text === null));
  } finally {
    s.close();
  }
});
test("conflicting event id is rejected atomically and search is literal scoped text", () => {
  const s = new Store(config(), () => now);
  try {
    s.ingest(producer, [event({ text: "Synthetic % keyword" })]);
    assert.throws(() => s.ingest(producer, [event({ text: "changed" })]), {
      code: "event_collision",
    });
    assert.equal(page(s, "search", { query: "%" }).items.length, 1);
    assert.equal(page(s, "search", { query: "' OR 1=1" }).items.length, 0);
  } finally {
    s.close();
  }
});
test("producer restricted to one conversation cannot revoke whole source", () => {
  const s = new Store(config(), () => now);
  try {
    assert.throws(
      () =>
        s.control(
          { ...producer, conversationIds: ["selected-a"] },
          {
            sourceId: source.id,
            accountId: source.accountId,
            generation: 1,
            action: "purge",
          },
        ),
      (e) => e instanceof BridgeError && e.status === 403,
    );
  } finally {
    s.close();
  }
});
test("independent connection cannot revoke inside atomic ingestion; revoke afterwards clears body", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-race-"));
  const file = join(dir, "store.sqlite");
  const a = new Store(config(file), () => now);
  const b = new Store(config(file), () => now);
  b.db.pragma("busy_timeout = 0");
  const original = a.sources.bind(a);
  let attempted = false;
  try {
    a.sources = () => {
      if (!attempted) {
        attempted = true;
        assert.throws(
          () =>
            b.control(producer, {
              sourceId: source.id,
              accountId: source.accountId,
              generation: 1,
              action: "revoke",
            }),
          (e) =>
            !!e &&
            typeof e === "object" &&
            "code" in e &&
            e.code === "SQLITE_BUSY",
        );
      }
      return original();
    };
    a.ingest(producer, [event()]);
    assert(attempted);
    b.control(producer, {
      sourceId: source.id,
      accountId: source.accountId,
      generation: 1,
      action: "revoke",
    });
    assert.equal(page(a).items.length, 0);
    assert.throws(
      () => a.ingest(producer, [event({ eventId: "after-revoke" })]),
      { code: "scope_denied" },
    );
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("pagination sequence is never reused after highest tombstone removal", () => {
  const s = new Store(config(), () => now);
  try {
    s.ingest(producer, [
      event({ eventId: "a", messageId: "a" }),
      event({ eventId: "b", messageId: "b" }),
      event({ eventId: "c", messageId: "c" }),
    ]);
    const first = page(s, "read_messages", { limit: 1 });
    s.db.prepare("DELETE FROM messages WHERE id=?").run("c");
    s.ingest(producer, [event({ eventId: "d", messageId: "d" })]);
    const last = page(s, "read_messages", { cursor: first.cursor });
    assert.equal(last.items.length, 1);
    assert.equal(last.cursor, null);
  } finally {
    s.close();
  }
});
test("change retention crossing a cursor checkpoint requires resynchronization", () => {
  let clock = now;
  const s = new Store(config(), () => clock);
  try {
    s.ingest(producer, [
      event({ eventId: "a", messageId: "a" }),
      event({ eventId: "b", messageId: "b" }),
      event({ eventId: "c", messageId: "c" }),
    ]);
    clock += 7 * 86400000 - 5000;
    const cp = page(s, "read_changes", { limit: 1 });
    clock += 6000;
    assert.throws(() => page(s, "read_changes", { cursor: cp.cursor }), {
      code: "cursor_expired_resync",
    });
  } finally {
    s.close();
  }
});
test("unrepresentable edit clears stale body with truthful recoverable tombstone", () => {
  const s = new Store(config(), () => now);
  try {
    s.ingest(producer, [event()]);
    s.ingest(producer, [
      {
        op: "delete",
        reason: "unavailable_edit",
        eventId: "unavailable",
        sourceId: source.id,
        accountId: source.accountId,
        conversationId: "selected-a",
        generation: 1,
        messageId: "synthetic-message",
        observedAt: now,
        revision: now,
      },
    ]);
    assert.equal(page(s).items.length, 0);
    assert.equal(
      (page(s, "read_changes").items[0] as { reason?: string }).reason,
      "unavailable_edit",
    );
    s.ingest(producer, [
      event({
        eventId: "restored",
        text: "Synthetic current edit",
        revision: now + 1,
      }),
    ]);
    assert.equal(page(s).items[0].text, "Synthetic current edit");
  } finally {
    s.close();
  }
});
test("all allowed source/conversation counts fit bounded SQL scope expressions", () => {
  const c = config();
  c.sources = Array.from({ length: 11 }, (_, i) => ({
    ...source,
    id: `source-${i}`,
    conversations: Array.from({ length: 100 }, (_, j) => ({ id: `conv-${j}` })),
  }));
  const s = new Store(c, () => now);
  const p = { ...reader, sourceIds: c.sources.map((v) => v.id) };
  try {
    for (const op of ["read_messages", "search", "read_changes"])
      assert.equal(
        (
          s.execute(p, op, op === "search" ? { query: "Synthetic" } : {}) as {
            items: unknown[];
          }
        ).items.length,
        0,
      );
  } finally {
    s.close();
  }
});
test("persistent messages and incremental checkpoint survive service restart without duplicate delivery", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-restart-"));
  const file = join(dir, "store.sqlite");
  let s = new Store(config(file), () => now);
  try {
    s.ingest(producer, [event()]);
    const cursor = page(s, "read_changes").cursor;
    s.close();
    s = new Store(config(file), () => now);
    assert.equal(page(s).items.length, 1);
    assert.equal(page(s, "read_changes", { cursor }).items.length, 0);
    assert.equal(s.ingest(producer, [event()]).accepted, 0);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
