import test from "node:test";
import assert from "node:assert/strict";
import {
  PersonalCapture,
  connectorUrl,
  sourceMatches,
} from "../packages/plugin/src/core.js";
import type { Source } from "../packages/domain/src/index.js";
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
