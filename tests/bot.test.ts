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
