import test from "node:test";
import assert from "node:assert/strict";
import {
  PersonalCapture,
  connectorUrl,
  sourceMatches,
  type ClientEvent,
} from "../packages/plugin/src/core.js";
import type { Source } from "../packages/domain/src/index.js";
import { Store } from "../packages/service/src/store.js";
import {
  config as storeConfig,
  source as fixtureSource,
  producer,
  reader,
  now as fixtureNow,
} from "./fixtures.js";
const packagedContract: typeof import("../packages/plugin/src/public-api.js").PersonalCapture =
  PersonalCapture;
void packagedContract;
const source: Source = {
  id: "personal",
  type: "personal",
  accountId: "account",
  enabled: true,
  generation: 1,
  conversations: [{ id: "selected" }],
};
const event = (channel = "selected", text = "synthetic") => ({
  type: "MESSAGE_CREATE",
  message: {
    id: "message",
    channel_id: channel,
    content: text,
    author: { id: "author" },
    timestamp: 1000,
  },
});
test("capture is paused by default; account, allowlist and channel types are enforced", () => {
  let account = "account";
  const capture = new PersonalCapture(
    source,
    () => account,
    (id) => (id === "server" ? 0 : 1),
    () => 2000,
  );
  assert.equal(capture.observe(event()), false);
  assert.equal(capture.resume(), true);
  assert.equal(capture.observe(event("excluded")), false);
  assert.equal(capture.observe(event("server")), false);
  assert.equal(capture.observe(event()), true);
  account = "other";
  assert.equal(capture.observe(event()), false);
  assert.equal(capture.queue.status().queueDepth, 0);
  assert.equal(capture.queue.status().paused, true);
});
test("passive mapping exports minimal fields; unknown edits remove stale bodies and historical loads are ignored", async () => {
  const capture = new PersonalCapture(
    source,
    () => "account",
    () => 3,
    () => 2000,
  );
  capture.resume();
  assert.equal(
    capture.observe({ ...event(), type: "MESSAGE_LOAD_SUCCESS" }),
    false,
  );
  assert.equal(
    capture.observe({
      type: "MESSAGE_UPDATE",
      message: { id: "message", channel_id: "selected", content: "partial" },
    }),
    true,
  );
  await capture.export(async (events) => {
    assert.equal(events[0].op, "delete");
    if (events[0].op === "delete")
      assert.equal(events[0].reason, "unavailable_edit");
    assert(!("text" in events[0]));
  });
  capture.observe(event());
  await capture.export(async (events) => {
    assert.equal(events.length, 1);
    assert.deepEqual(
      Object.keys(events[0]).sort(),
      [
        "accountId",
        "authorId",
        "conversationId",
        "createdAt",
        "eventId",
        "generation",
        "messageId",
        "observedAt",
        "op",
        "revision",
        "sourceId",
        "text",
      ].sort(),
    );
  });
});
test("edit/delete overwrite queued bodies and scope changes purge", async () => {
  const capture = new PersonalCapture(
    source,
    () => "account",
    () => 1,
    () => 2000,
  );
  capture.resume();
  capture.observe(event());
  capture.observe({
    type: "MESSAGE_UPDATE",
    message: { ...event().message, content: "edited", edited_timestamp: 1500 },
  });
  capture.observe({
    type: "MESSAGE_DELETE",
    channelId: "selected",
    id: "message",
  });
  capture.observe(event());
  await capture.export(async (events) => {
    assert.equal(events.length, 1);
    assert.equal(events[0].op, "delete");
    assert.equal("text" in events[0], false);
  });
  capture.observe(event());
  capture.configure({ ...source, conversations: [] });
  assert.equal(capture.queue.status().queueDepth, 0);
  assert.equal(capture.queue.status().paused, true);
});
test("export account recheck and safe origin constraints", async () => {
  let account = "account";
  const capture = new PersonalCapture(
    source,
    () => account,
    () => 1,
  );
  capture.resume();
  capture.observe(event());
  account = "other";
  await capture.export(async () => assert.fail("must not export"));
  assert.equal(capture.queue.status().queueDepth, 0);
  assert.equal(
    connectorUrl("https://example.invalid"),
    "https://example.invalid",
  );
  assert.equal(connectorUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  for (const value of [
    "http://example.invalid",
    "https://" + "user:password@example.invalid",
    "https://example.invalid/path",
    "https://example.invalid?credential=x",
  ])
    assert.throws(() => connectorUrl(value));
});
test("bounded queue, TTL and paused/restarted coverage", () => {
  let now = 2000;
  const capture = new PersonalCapture(
    source,
    () => "account",
    () => 1,
    () => now,
    1,
    100,
  );
  capture.resume();
  capture.observe(event());
  capture.observe({
    ...event(),
    message: { ...event().message, id: "second" },
  });
  assert.equal(capture.queue.status().queueDepth, 1);
  assert.equal(capture.queue.status().overflow, 1);
  now = 2200;
  assert.equal(capture.queue.status().queueDepth, 0);
  assert.equal(capture.queue.status().overflow, 2);
  capture.queue.connected(false);
  assert.ok(capture.queue.status().gapSince);
  capture.queue.pause();
  assert.equal(capture.queue.status().paused, true);
  const restarted = new PersonalCapture(
    source,
    () => "account",
    () => 1,
    () => now,
  );
  assert.equal(restarted.queue.status().queueDepth, 0);
  assert.ok(restarted.queue.status().gapSince);
});

test("malformed observed IDs are rejected without throwing or logging content", () => {
  const capture = new PersonalCapture(
    source,
    () => "account",
    () => 1,
    () => 2000,
  );
  capture.resume();
  assert.equal(
    capture.observe({
      ...event(),
      message: { ...event().message, id: "invalid id" },
    }),
    false,
  );
  assert.equal(capture.queue.status().queueDepth, 0);
});

test("partial edits use only bounded observed metadata and lose knowledge on pause, TTL and deletion", async () => {
  let now = 2000;
  const capture = new PersonalCapture(
    source,
    () => "account",
    () => 1,
    () => now,
    1,
    100,
  );
  capture.resume();
  capture.observe(event());
  assert.equal(
    capture.observe({
      type: "MESSAGE_UPDATE",
      message: {
        id: "message",
        channel_id: "selected",
        content: "partial edit",
        edited_timestamp: 2100,
      },
    }),
    true,
  );
  await capture.export(async (events) => {
    assert.equal(events.length, 1);
    assert.equal(events[0].op, "upsert");
    if (events[0].op === "upsert") {
      assert.equal(events[0].text, "partial edit");
      assert.equal(events[0].authorId, "author");
    }
  });
  now = 2200;
  assert.equal(
    capture.observe({
      type: "MESSAGE_UPDATE",
      message: { id: "message", channel_id: "selected", content: "expired" },
    }),
    true,
  );
  capture.observe(event());
  capture.pause();
  capture.resume();
  assert.equal(
    capture.observe({
      type: "MESSAGE_UPDATE",
      message: { id: "message", channel_id: "selected", content: "paused" },
    }),
    true,
  );
  capture.observe(event());
  capture.observe({
    type: "MESSAGE_DELETE",
    channelId: "selected",
    id: "message",
  });
  assert.equal(
    capture.observe({
      type: "MESSAGE_UPDATE",
      message: { id: "message", channel_id: "selected", content: "deleted" },
    }),
    false,
  );
});
test("resume scope check requires exact authenticated generation and conversation set", () => {
  assert.equal(sourceMatches(source, source), true);
  assert.equal(sourceMatches(source, source, 2), false);
  assert.equal(sourceMatches(source, { ...source, generation: 2 }), false);
  assert.equal(sourceMatches(source, { ...source, enabled: false }), false);
  assert.equal(sourceMatches(source, { ...source, accountId: "other" }), false);
  assert.equal(
    sourceMatches(source, {
      ...source,
      conversations: [{ id: "selected" }, { id: "excluded" }],
    }),
    false,
  );
});

test("duplicate conversation selections cannot fake an exact remote scope", () => {
  assert.equal(
    sourceMatches(
      { ...source, conversations: [{ id: "selected" }, { id: "selected" }] },
      { ...source, conversations: [{ id: "selected" }, { id: "excluded" }] },
    ),
    false,
  );
});

test("persisted revocation barrier requires a complete source view after restart", () => {
  const selected = {
    ...source,
    generation: 2,
    conversations: [{ id: "selected" }],
  };
  // A grant narrowed to selected projects away a still-enabled old conversation.
  // An unrelated generation bump does not acknowledge its global revocation.
  const projected = { ...selected };
  assert.equal(sourceMatches(selected, projected, 2), false);
  assert.equal(sourceMatches(selected, projected, 2, false), false);
  assert.equal(sourceMatches(selected, projected, 2, true), true);
  const complete = {
    ...selected,
    conversations: [{ id: "selected" }, { id: "old" }],
  };
  assert.equal(sourceMatches(selected, complete, 2, true), false);
  // An initial scoped producer can still observe its explicit permitted subset.
  assert.equal(sourceMatches(selected, projected, 0, false), true);
});

test("content-less delivered update clears exported current body with recoverable tombstone and preserves capture scope", async () => {
  let clock = fixtureNow;
  let account = fixtureSource.accountId;
  const selected = { ...fixtureSource, conversations: [{ id: "selected-a" }] };
  const cfg = storeConfig();
  cfg.sources = [selected];
  const store = new Store(cfg, () => clock);
  const capture = new PersonalCapture(
    selected,
    () => account,
    () => 1,
    () => clock,
  );
  const delivered = {
    ...event().message,
    channel_id: "selected-a",
    author: { id: "synthetic-author" },
    timestamp: fixtureNow - 1000,
    content: "Synthetic original body",
  };
  const flush = () =>
    capture.export(async (events, health) => {
      store.ingest(producer, events, health);
    });
  const page = () =>
    store.execute(reader, "read_messages") as { items: { text: string }[] };
  try {
    capture.resume();
    assert.equal(
      capture.observe({ type: "MESSAGE_CREATE", message: delivered }),
      true,
    );
    await flush();
    assert.equal(page().items[0].text, "Synthetic original body");
    const prior = store.execute(reader, "read_changes") as { cursor: string };
    clock++;
    assert.equal(
      capture.observe({
        type: "MESSAGE_UPDATE",
        message: {
          id: "message",
          channel_id: "selected-a",
          edited_timestamp: clock,
        },
      }),
      true,
    );
    await flush();
    assert.equal(page().items.length, 0);
    const changes = store.execute(reader, "read_changes", {
      cursor: prior.cursor,
    }) as { items: { op: string; reason?: string; message?: unknown }[] };
    assert.equal(changes.items.length, 1);
    assert.equal(changes.items[0].op, "delete");
    assert.equal(changes.items[0].reason, "unavailable_edit");
    assert.equal(changes.items[0].message, undefined);
    assert.equal(
      JSON.stringify(changes).includes("Synthetic original body"),
      false,
    );
    assert.equal(
      capture.observe({
        type: "MESSAGE_UPDATE",
        message: { id: "message", channel_id: "selected-b" },
      }),
      false,
    );
    account = "different-account";
    assert.equal(
      capture.observe({
        type: "MESSAGE_UPDATE",
        message: { id: "message", channel_id: "selected-a" },
      }),
      false,
    );
    assert.equal(capture.queue.status().queueDepth, 0);
    assert.equal(page().items.length, 0);
    account = fixtureSource.accountId;
    capture.resume();
    clock++;
    assert.equal(
      capture.observe({
        type: "MESSAGE_UPDATE",
        message: {
          ...delivered,
          edited_timestamp: clock,
          content: "Synthetic newer complete edit",
        },
      }),
      true,
    );
    await flush();
    assert.equal(page().items[0].text, "Synthetic newer complete edit");
  } finally {
    store.close();
  }
});
test("unrepresentable update replaces queued body while malformed creates and unidentified updates are rejected", async () => {
  const variants: [string, Record<string, unknown>][] = [
    ["missing text", { content: undefined }],
    ["non-string text", { content: 123 }],
    ["over-limit text", { content: "x".repeat(8001) }],
    ["invalid edit timestamp", { edited_timestamp: "not-a-timestamp" }],
    ["invalid author", { author: { id: "invalid author id" } }],
  ];
  for (const [label, patch] of variants) {
    const capture = new PersonalCapture(
      source,
      () => source.accountId,
      () => 1,
      () => 2000,
    );
    capture.resume();
    const malformedCreate = {
      ...event(),
      message: {
        ...event().message,
        ...patch,
        ...(label === "invalid edit timestamp"
          ? { timestamp: "not-a-timestamp" }
          : {}),
      },
    } as unknown as ClientEvent;
    assert.equal(capture.observe(malformedCreate), false, label);
    assert.equal(capture.observe(event()), true);
    assert.equal(
      capture.observe({
        type: "MESSAGE_UPDATE",
        message: { ...event().message, edited_timestamp: 1500, ...patch },
      } as unknown as ClientEvent),
      true,
      label,
    );
    await capture.export(async (events) => {
      assert.equal(events.length, 1, label);
      assert.equal(events[0].op, "delete", label);
      assert.equal("text" in events[0], false, label);
      if (events[0].op === "delete")
        assert.equal(events[0].reason, "unavailable_edit", label);
    });
  }
  const capture = new PersonalCapture(
    source,
    () => source.accountId,
    () => 1,
    () => 2000,
  );
  capture.resume();
  capture.observe(event());
  for (const messageId of [undefined, "", "invalid id"])
    assert.equal(
      capture.observe({
        type: "MESSAGE_UPDATE",
        message: { id: messageId, channel_id: "selected" },
      }),
      false,
    );
  await capture.export(async (events) => {
    assert.equal(events.length, 1);
    assert.equal(events[0].op, "upsert");
  });
});
