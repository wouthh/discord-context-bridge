import { randomUUID } from "node:crypto";
import { PermissionsBitField } from "discord.js";
import {
  allowed,
  type Source,
  type Observation,
} from "../../domain/src/index.js";

export function canRead(bits: bigint | null): boolean {
  return (
    bits !== null &&
    !(bits & PermissionsBitField.Flags.Administrator) &&
    (bits & PermissionsBitField.Flags.ViewChannel) !== 0n &&
    (bits & PermissionsBitField.Flags.ReadMessageHistory) !== 0n
  );
}
export interface MessageInput {
  id: string;
  channelId: string;
  guildId: string | null;
  createdTimestamp?: number;
  editedTimestamp?: number | null;
  author?: { id: string } | null;
  content?: string | null;
}
export function mapMessage(
  source: Source,
  message: MessageInput,
  op: "upsert" | "delete",
  now = Date.now(),
): Observation | null {
  const selected = source.conversations.find(
    (c) => c.id === message.channelId && c.guildId === message.guildId,
  );
  if (
    source.type !== "bot" ||
    !selected ||
    !allowed(source, source.accountId, message.channelId, source.generation)
  )
    return null;
  const base = {
    eventId: randomUUID(),
    sourceId: source.id,
    accountId: source.accountId,
    conversationId: message.channelId,
    generation: source.generation,
    messageId: message.id,
    observedAt: now,
  };
  if (op === "delete") return { ...base, op, revision: now };
  if (
    !message.author ||
    typeof message.content !== "string" ||
    message.createdTimestamp === undefined
  )
    return null;
  return {
    ...base,
    op,
    revision: message.editedTimestamp ?? message.createdTimestamp,
    createdAt: message.createdTimestamp,
    authorId: message.author.id,
    text: message.content.slice(0, 8000),
  };
}
export function bridgeUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(url.protocol === "https:" || (loopback && url.protocol === "http:"))
  )
    throw new Error("INVALID_BRIDGE_URL");
  return url;
}
export function boundedSetting(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max)
    throw new Error("INVALID_BOT_SETTING");
  return number;
}

/** Bounded metadata from this reader's own delivered events; never stores bodies. */
export class ObservedMetadata {
  private entries = new Map<
    string,
    { authorId: string; createdAt: number; observedAt: number }
  >();
  constructor(
    private max = 500,
    private ttlMs = 3600000,
  ) {}
  clear() {
    this.entries.clear();
  }
  observe(
    source: Source,
    message: MessageInput,
    op: "upsert" | "delete",
    now = Date.now(),
    isUpdate = false,
  ): Observation | null {
    for (const [key, value] of this.entries)
      if (value.observedAt < now - this.ttlMs) this.entries.delete(key);
    const key = `${source.id}:${source.generation}:${message.channelId}:${message.id}`;
    const known = this.entries.get(key);
    if (op === "delete") {
      this.entries.delete(key);
      return mapMessage(source, message, op, now);
    }
    const enriched: MessageInput = {
      ...message,
      author: message.author ?? (known ? { id: known.authorId } : undefined),
      createdTimestamp: message.createdTimestamp ?? known?.createdAt,
    };
    // Missing edit revision cannot safely overwrite a newer delayed event. Remove
    // the body conservatively rather than silently leave a stale representation.
    const mapped =
      isUpdate && message.editedTimestamp == null
        ? null
        : mapMessage(source, enriched, op, now);
    if (!mapped) {
      if (!isUpdate) return null;
      this.entries.delete(key);
      const removed = mapMessage(source, message, "delete", now);
      return removed?.op === "delete"
        ? { ...removed, reason: "unavailable_edit" }
        : null;
    }
    if (mapped.op === "upsert") {
      this.entries.delete(key);
      if (this.entries.size >= this.max)
        this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(key, {
        authorId: mapped.authorId,
        createdAt: mapped.createdAt,
        observedAt: now,
      });
    }
    return mapped;
  }
}
