import test from "node:test";
import assert from "node:assert/strict";
import { PermissionsBitField as P } from "discord.js";
import {
  ObservedMetadata,
  boundedSetting,
  bridgeUrl,
  canRead,
  mapMessage,
} from "../packages/bot/src/mapper.js";
import { type Source } from "../packages/domain/src/index.js";
const source: Source = {
  id: "bot_source",
  type: "bot",
  accountId: "bot_account",
  enabled: true,
  generation: 1,
  conversations: [{ id: "selected", guildId: "guild" }],
};
const message = {
  id: "message",
  channelId: "selected",
  guildId: "guild",
  author: { id: "author" },
  content: "Synthetic text",
  createdTimestamp: 100,
};
test("bot requires exact channel and guild; disabled scope and personal source reject", () => {
  assert.ok(mapMessage(source, message, "upsert", 200));
  for (const input of [
    { ...message, channelId: "excluded" },
    { ...message, guildId: "other" },
    { ...message, guildId: null },
  ])
    assert.equal(mapMessage(source, input, "upsert"), null);
  assert.equal(
    mapMessage({ ...source, enabled: false }, message, "upsert"),
    null,
  );
  assert.equal(
    mapMessage({ ...source, type: "personal" }, message, "upsert"),
    null,
  );
});
test("requires minimum permissions and refuses Administrator", () => {
  const minimum = P.Flags.ViewChannel | P.Flags.ReadMessageHistory;
  assert.equal(canRead(minimum), true);
  for (const bits of [
    null,
    0n,
    P.Flags.ViewChannel,
    P.Flags.ReadMessageHistory,
    minimum | P.Flags.Administrator,
  ])
    assert.equal(canRead(bits), false);
});
test("history/delayed creates preserve Discord revision; edit replaces content; partial delete retains no body", () => {
  assert.equal(mapMessage(source, message, "upsert", 900)?.revision, 100);
  const edit = mapMessage(
    source,
    { ...message, content: "Edited synthetic text", editedTimestamp: 500 },
    "upsert",
    901,
  );
  assert.equal(edit?.revision, 500);
  const partial = {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
  };
  assert.equal(mapMessage(source, partial, "upsert"), null);
  const deletion = mapMessage(source, partial, "delete", 902);
  assert.equal(deletion?.op, "delete");
  assert.equal("text" in deletion!, false);
  assert.equal(deletion?.revision, 902);
});
test("producer URL denies credential URLs and unencrypted remote addresses; settings bounded", () => {
  assert.equal(bridgeUrl("http://127.0.0.1:3000").hostname, "127.0.0.1");
  assert.equal(bridgeUrl("https://bridge.example.invalid").protocol, "https:");
  for (const value of [
    "http://bridge.example.invalid",
    "https://" + "user:secret@bridge.example.invalid",
    "https://bridge.example.invalid/?token=synthetic",
    "https://bridge.example.invalid/path",
  ])
    assert.throws(() => bridgeUrl(value));
  assert.equal(boundedSetting(undefined, 50, 0, 100), 50);
  for (const value of ["101", "-1", "NaN", "1.5"])
    assert.throws(() => boundedSetting(value, 50, 0, 100));
});
test("delivered partial bot edit reuses bounded observed metadata without reusing a body", () => {
  const metadata = new ObservedMetadata(1, 1000);
  metadata.observe(source, message, "upsert", 200);
  const partial = {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    content: "New delivered content",
    editedTimestamp: 300,
  };
  const edited = metadata.observe(source, partial, "upsert", 400, true);
  assert.equal(edited?.op, "upsert");
  if (edited?.op === "upsert") {
    assert.equal(edited.text, "New delivered content");
    assert.equal(edited.authorId, message.author.id);
    assert.equal(edited.createdAt, 100);
    assert.equal(edited.revision, 300);
  }
  // A revisionless edit cannot safely replace a more recent body.
  const unknownRevision = metadata.observe(
    source,
    { ...partial, editedTimestamp: undefined },
    "upsert",
    500,
    true,
  );
  assert.equal(unknownRevision?.op, "delete");
  assert.equal("text" in unknownRevision!, false);
});
test("metadata expiry, eviction, clearing, and different generations conservatively remove unrepresentable updates", () => {
  const partial = {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    content: "Delivered edit",
    editedTimestamp: 500,
  };
  for (const mutate of [
    (m: ObservedMetadata) => m.clear(),
    (m: ObservedMetadata) =>
      m.observe(source, { ...message, id: "other_message" }, "upsert", 201),
  ]) {
    const metadata = new ObservedMetadata(1, 1000);
    metadata.observe(source, message, "upsert", 200);
    mutate(metadata);
    assert.equal(
      metadata.observe(source, partial, "upsert", 400, true)?.op,
      "delete",
    );
  }
  const metadata = new ObservedMetadata(1, 1000);
  metadata.observe(source, message, "upsert", 200);
  assert.equal(
    metadata.observe({ ...source, generation: 2 }, partial, "upsert", 400, true)
      ?.op,
    "delete",
  );
  assert.equal(
    metadata.observe(source, partial, "upsert", 1300, true)?.op,
    "delete",
  );
  assert.equal(
    metadata.observe(
      source,
      { ...partial, channelId: "excluded" },
      "upsert",
      1400,
      true,
    ),
    null,
  );
});

test("lost revocation response reconciles authenticated scope and exports the remaining conversation", async () => {
  const { processPendingRevocations } =
    await import("../packages/bot/src/revocation.js");
  const { Store } = await import("../packages/service/src/store.js");
  const { DeliveryQueue } = await import("../packages/sources/src/queue.js");
  const fixtures = await import("./fixtures.js");
  const selected: Source = {
    ...source,
    conversations: [
      ...source.conversations,
      { id: "remaining", guildId: "guild" },
    ],
  };
  const configuration = fixtures.config();
  configuration.sources = [selected];
  const producer = { ...fixtures.producer, sourceIds: [selected.id] };
  const reader = { ...fixtures.reader, sourceIds: [selected.id] };
  const store = new Store(configuration, () => fixtures.now);
  const pending = new Map([["selected", selected]]);
  let controls = 0;
  try {
    // The server commits, but the simulated network loses the acknowledgement.
    await assert.rejects(
      processPendingRevocations(pending, selected, async (request) => {
        controls++;
        store.control(producer, request);
        throw new Error("synthetic-response-lost");
      }),
      /synthetic-response-lost/,
    );
    assert.equal(pending.size, 1);
    const refreshed = store.producerScope(producer).sources[0];
    assert.equal(refreshed.generation, 2);
    assert.equal(
      refreshed.conversations.some((c) => c.id === "selected"),
      false,
    );
    const queue = new DeliveryQueue(
      refreshed,
      500,
      3600000,
      () => fixtures.now,
    );
    queue.pause(false);
    queue.connected(true);
    const remaining = mapMessage(
      refreshed,
      {
        ...message,
        channelId: "remaining",
        createdTimestamp: fixtures.now - 1000,
      },
      "upsert",
      fixtures.now,
    )!;
    assert.equal(queue.capture(remaining), true);
    assert.equal(
      await processPendingRevocations(pending, refreshed, async () => {
        controls++;
        throw new Error("unexpected-second-control");
      }),
      false,
    );
    assert.equal(pending.size, 0);
    assert.equal(controls, 1);
    await queue.flush(async (events, health) => {
      assert.equal(store.ingest(producer, events, health).accepted, 1);
    });
    assert.equal(queue.status().queueDepth, 0);
    const result = store.execute(reader, "read_messages", {}) as {
      items: { conversationId: string }[];
    };
    assert.deepEqual(
      result.items.map((item) => item.conversationId),
      ["remaining"],
    );
    assert.equal(
      queue.capture({
        ...remaining,
        eventId: "excluded-retry",
        conversationId: "selected",
      }),
      false,
    );
  } finally {
    store.close();
  }
});
test("revocation acknowledgement requires matching identity, newer generation and absent conversation", async () => {
  const { processPendingRevocations } =
    await import("../packages/bot/src/revocation.js");
  for (const refreshed of [
    { ...source, generation: 2, accountId: "other" },
    { ...source, generation: 2, id: "other" },
  ]) {
    const pending = new Map([["selected", source]]);
    await assert.rejects(
      processPendingRevocations(pending, refreshed, async () => {
        throw new Error("unexpected-control");
      }),
      /IDENTITY_MISMATCH/,
    );
    assert.equal(pending.size, 1);
  }
  for (const refreshed of [
    { ...source, conversations: [] },
    { ...source, generation: 2 },
  ]) {
    const pending = new Map([["selected", source]]);
    let attempted = false;
    await assert.rejects(
      processPendingRevocations(pending, refreshed, async () => {
        attempted = true;
        throw new Error("synthetic-control-failed");
      }),
      /synthetic-control-failed/,
    );
    assert.equal(attempted, true);
    assert.equal(pending.size, 1);
  }
});
