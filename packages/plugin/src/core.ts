import { z } from "zod";
import {
  sourceSchema,
  allowed,
  type Source,
  type Observation,
} from "../../domain/src/index.js";
import { DeliveryQueue } from "../../sources/src/queue.js";
export type ClientMessage = {
  id?: string;
  channel_id?: string;
  content?: string;
  author?: { id?: string };
  timestamp?: string | number;
  edited_timestamp?: string | number | null;
};
export type ClientEvent = {
  type: string;
  message?: ClientMessage;
  channelId?: string;
  channel_id?: string;
  id?: string;
  ids?: string[];
};
export class PersonalCapture {
  readonly queue: DeliveryQueue;
  private metadata = new Map<
    string,
    {
      authorId: string;
      createdAt: number;
      revision: number;
      observedAt: number;
    }
  >();
  constructor(
    source: Source,
    private account: () => string | undefined,
    private channelType: (id: string) => number | undefined,
    private now = Date.now,
    private max = 500,
    private ttlMs = 3600000,
  ) {
    if (source.type !== "personal") throw new Error("personal_source_required");
    this.queue = new DeliveryQueue(sourceSchema.parse(source), max, ttlMs, now);
  }
  configure(source: Source) {
    if (source.type !== "personal") throw new Error("personal_source_required");
    this.metadata.clear();
    this.queue.configure(sourceSchema.parse(source));
  }
  pause() {
    this.metadata.clear();
    this.queue.purge();
  }
  private expireMetadata() {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, value] of this.metadata)
      if (value.observedAt < cutoff) this.metadata.delete(key);
  }
  private enqueue(event: Observation) {
    try {
      const accepted = this.queue.capture(event);
      if (accepted) this.queue.connected(true);
      return accepted;
    } catch {
      return false;
    }
  }
  resume() {
    if (
      this.account() !== this.queue.source.accountId ||
      !this.queue.source.enabled
    )
      return false;
    this.queue.pause(false);
    return true;
  }
  observe(event: ClientEvent) {
    if (this.account() !== this.queue.source.accountId) {
      this.pause();
      return false;
    }
    const channel =
      event.message?.channel_id ?? event.channelId ?? event.channel_id;
    if (!channel || ![1, 3].includes(this.channelType(channel) ?? -1))
      return false;
    const now = this.now();
    const source = this.queue.source;
    if (
      !allowed(source, source.accountId, channel, source.generation) ||
      this.queue.status().paused
    )
      return false;
    this.expireMetadata();
    const make = (messageId: string): Omit<Observation, "op"> => ({
      eventId: crypto.randomUUID(),
      sourceId: source.id,
      accountId: source.accountId,
      conversationId: channel,
      generation: source.generation,
      messageId,
      observedAt: now,
      revision: now,
    });
    if (
      event.type === "MESSAGE_DELETE" ||
      event.type === "MESSAGE_DELETE_BULK"
    ) {
      const ids =
        event.type === "MESSAGE_DELETE_BULK"
          ? event.ids
          : event.id
            ? [event.id]
            : [];
      let accepted = false;
      for (const id of (ids ?? []).slice(0, 1000)) {
        this.metadata.delete(channel + ":" + id);
        accepted = this.enqueue({ ...make(id), op: "delete" }) || accepted;
      }
      return accepted;
    }
    if (!["MESSAGE_CREATE", "MESSAGE_UPDATE"].includes(event.type))
      return false;
    const msg = event.message;
    // Keep only bounded metadata from events already observed in scope, never bodies.
    if (
      !msg?.id ||
      typeof msg.content !== "string" ||
      msg.content.length > 8000
    )
      return false;
    const key = channel + ":" + msg.id;
    const known = this.metadata.get(key);
    const authorId = msg.author?.id ?? known?.authorId;
    const created =
      msg.timestamp !== undefined
        ? typeof msg.timestamp === "number"
          ? msg.timestamp
          : Date.parse(msg.timestamp)
        : known?.createdAt;
    const revised = msg.edited_timestamp
      ? typeof msg.edited_timestamp === "number"
        ? msg.edited_timestamp
        : Date.parse(msg.edited_timestamp)
      : event.type === "MESSAGE_UPDATE"
        ? now
        : created;
    if (
      !authorId ||
      created === undefined ||
      revised === undefined ||
      (event.type === "MESSAGE_UPDATE" && !msg.edited_timestamp)
    ) {
      if (event.type !== "MESSAGE_UPDATE") return false;
      this.metadata.delete(key);
      this.queue.connected(false);
      return this.enqueue({
        ...make(msg.id),
        op: "delete",
        reason: "unavailable_edit",
      });
    }
    if (
      !Number.isSafeInteger(created) ||
      created < 0 ||
      !Number.isSafeInteger(revised) ||
      revised < 0
    )
      return false;
    const accepted = this.enqueue({
      ...make(msg.id),
      op: "upsert",
      createdAt: created,
      revision: revised,
      authorId,
      text: msg.content,
    });
    if (accepted && (!known || revised >= known.revision)) {
      this.metadata.delete(key);
      if (this.metadata.size >= this.max)
        this.metadata.delete(this.metadata.keys().next().value!);
      this.metadata.set(key, {
        authorId,
        createdAt: created,
        revision: revised,
        observedAt: now,
      });
    }
    return accepted;
  }
  async export(send: Parameters<DeliveryQueue["flush"]>[0]) {
    this.expireMetadata();
    if (this.account() !== this.queue.source.accountId) {
      this.pause();
      return;
    }
    await this.queue.flush(send);
  }
}
export function connectorUrl(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("invalid_connector_origin");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
    )
  )
    throw new Error("https_required");
  return url.origin;
}

export function sourceMatches(
  selected: Source,
  remote: Source,
  minimumGeneration = 0,
  conversationScopeComplete = false,
) {
  return (
    selected.type === "personal" &&
    remote.type === "personal" &&
    selected.enabled &&
    remote.enabled &&
    selected.id === remote.id &&
    selected.accountId === remote.accountId &&
    selected.generation === remote.generation &&
    remote.generation >= minimumGeneration &&
    (minimumGeneration === 0 || conversationScopeComplete === true) &&
    new Set(selected.conversations.map((c) => c.id)).size ===
      selected.conversations.length &&
    new Set(remote.conversations.map((c) => c.id)).size ===
      remote.conversations.length &&
    selected.conversations.length === remote.conversations.length &&
    selected.conversations.every((c) =>
      remote.conversations.some((r) => r.id === c.id),
    )
  );
}

export type ControlRetryPlan =
  | { state: "blocked" }
  | { state: "acknowledged" }
  | { state: "send"; generation: number };
/** Only explicit control attempts call this; generation changes alone never prove purge. */
export function planControlRetry(
  original: Source,
  action: "purge" | "revoke",
  conversationId: string | undefined,
  remote: Source | undefined,
  conversationScopeComplete = false,
): ControlRetryPlan {
  const parsed = sourceSchema.safeParse(remote);
  if (!parsed.success) return { state: "blocked" };
  remote = parsed.data;
  if (
    new Set(original.conversations.map((c) => c.id)).size !==
      original.conversations.length ||
    new Set(remote.conversations.map((c) => c.id)).size !==
      remote.conversations.length
  )
    return { state: "blocked" };
  if (
    original.type !== "personal" ||
    remote.id !== original.id ||
    remote.type !== original.type ||
    remote.accountId !== original.accountId ||
    remote.generation < original.generation
  )
    return { state: "blocked" };
  if (
    conversationId &&
    !original.conversations.some((c) => c.id === conversationId)
  )
    return { state: "blocked" };
  const targetVisible = conversationId
    ? remote.conversations.some((c) => c.id === conversationId)
    : false;
  if (
    action === "revoke" &&
    remote.generation > original.generation &&
    conversationScopeComplete === true &&
    (conversationId ? !targetVisible : !remote.enabled)
  )
    return { state: "acknowledged" };
  if (conversationId) {
    if (!targetVisible) return { state: "blocked" };
  } else {
    // Never replay a whole-source operation against a widened or projected scope.
    if (
      conversationScopeComplete !== true ||
      original.conversations.length !== remote.conversations.length ||
      !original.conversations.every((c) =>
        remote.conversations.some(
          (r) => r.id === c.id && r.guildId === c.guildId,
        ),
      )
    )
      return { state: "blocked" };
  }
  return { state: "send", generation: remote.generation };
}

const controlBarrierSchema = z
  .object({
    version: z.literal(1),
    endpoint: z.string().max(2048),
    original: sourceSchema.extend({
      enabled: z.boolean(),
      generation: z.number().int().positive(),
    }),
    action: z.enum(["purge", "revoke"]),
    conversationId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,80}$/)
      .optional(),
    confirmed: z.boolean(),
    minimumGeneration: z.number().int().positive(),
  })
  .strict()
  .refine(
    (b) =>
      b.original.type === "personal" &&
      b.minimumGeneration > b.original.generation &&
      new Set(b.original.conversations.map((c) => c.id)).size ===
        b.original.conversations.length &&
      (!b.conversationId ||
        b.original.conversations.some((c) => c.id === b.conversationId)),
    "invalid_control_barrier",
  );
export type ControlBarrier = z.infer<typeof controlBarrierSchema>;
export function parseControlBarrier(value: string): ControlBarrier | null {
  if (!value) return null;
  const barrier = controlBarrierSchema.parse(JSON.parse(value));
  if (connectorUrl(barrier.endpoint) !== barrier.endpoint)
    throw new Error("invalid_control_origin");
  return barrier;
}
export function createControlBarrier(
  original: Source,
  action: "purge" | "revoke",
  endpoint: string,
  conversationId?: string,
): ControlBarrier {
  return parseControlBarrier(
    JSON.stringify({
      version: 1,
      endpoint: connectorUrl(endpoint),
      original,
      action,
      ...(conversationId ? { conversationId } : {}),
      confirmed: false,
      minimumGeneration: original.generation + 1,
    }),
  )!;
}
export function confirmControlBarrier(
  barrier: ControlBarrier,
  generation: number,
): ControlBarrier {
  if (
    !Number.isSafeInteger(generation) ||
    generation <= barrier.original.generation
  )
    throw new Error("control_generation_unconfirmed");
  return parseControlBarrier(
    JSON.stringify({
      ...barrier,
      confirmed: true,
      minimumGeneration: Math.max(barrier.minimumGeneration, generation),
    }),
  )!;
}
export function controlBarrierMinimum(
  barrier: ControlBarrier | null,
  source: Source,
  endpoint: string,
) {
  if (!barrier) return 0;
  if (!barrier.confirmed) throw new Error("control_unconfirmed");
  return barrier.endpoint === connectorUrl(endpoint) &&
    barrier.original.id === source.id &&
    barrier.original.accountId === source.accountId &&
    barrier.original.type === source.type
    ? barrier.minimumGeneration
    : 0;
}
