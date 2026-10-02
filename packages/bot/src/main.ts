import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  Events,
  type Message,
  type PartialMessage,
} from "discord.js";
import { sourceSchema, type Source } from "../../domain/src/index.js";
import { DeliveryQueue } from "../../sources/src/queue.js";
import { readSecret } from "../../service/src/secrets.js";
import {
  boundedSetting,
  bridgeUrl,
  canRead,
  ObservedMetadata,
} from "./mapper.js";

async function main() {
  const base = bridgeUrl(process.env.BRIDGE_URL ?? "http://127.0.0.1:8787");
  const sourceId = process.env.BRIDGE_SOURCE_ID;
  if (!sourceId) throw new Error("SOURCE_ID_REQUIRED");
  const historyLimit = boundedSetting(
    process.env.BOT_HISTORY_LIMIT,
    50,
    0,
    100,
  );
  const retentionMs =
    boundedSetting(process.env.BOT_HISTORY_DAYS, 7, 1, 365) * 86400000;
  const producerToken = await readSecret("BRIDGE_PRODUCER_TOKEN");
  const botToken = await readSecret("DISCORD_BOT_TOKEN");
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel],
  });
  let source: Source | undefined,
    queue: DeliveryQueue | undefined,
    busy = false,
    closed = false;
  let signature = "";
  const metadata = new ObservedMetadata();
  const revoked = new Set<string>();
  const pending = new Map<string, Source>();
  async function request(path: string, body?: unknown, signal?: AbortSignal) {
    const response = await fetch(new URL(path, base), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${producerToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("BRIDGE_REQUEST_FAILED");
    return response;
  }
  function permitted(channelId: string) {
    const selected = source?.conversations.find((c) => c.id === channelId);
    const channel = client.channels.cache.get(channelId);
    if (
      !selected ||
      !channel ||
      channel.type !== ChannelType.GuildText ||
      channel.guildId !== selected.guildId ||
      !client.user
    )
      return false;
    return canRead(channel.permissionsFor(client.user)?.bitfield ?? null);
  }
  function revoke(channelId: string) {
    if (!source || revoked.has(channelId)) return;
    revoked.add(channelId);
    pending.set(channelId, source);
    source = {
      ...source,
      conversations: source.conversations.filter((c) => c.id !== channelId),
    };
    // Abort in-flight export and clear every queued body before attempting remote revocation.
    metadata.clear();
    queue?.configure(source);
    queue?.pause(false);
    queue?.connected(client.isReady());
  }
  function accessLost(error: unknown) {
    return (
      !!error &&
      typeof error === "object" &&
      "code" in error &&
      [50001, 50013, 10003, 10004].includes(Number(error.code))
    );
  }
  async function checkPermissions(refresh = false) {
    const current = source;
    if (!client.isReady() || !current) return;
    if (refresh) {
      // Read only our bot member and selected channels; do not request a member inventory.
      for (const guildId of new Set(
        current.conversations.map((c) => c.guildId),
      )) {
        if (!guildId) continue;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
          for (const c of current.conversations)
            if (c.guildId === guildId) revoke(c.id);
          continue;
        }
        try {
          await guild.members.fetchMe({ force: true });
        } catch (error) {
          if (!accessLost(error)) throw error;
          for (const c of current.conversations)
            if (c.guildId === guildId) revoke(c.id);
          return;
        }
      }
      for (const c of current.conversations) {
        try {
          await client.channels.fetch(c.id, { force: true });
        } catch (error) {
          if (!accessLost(error)) throw error;
          revoke(c.id);
          return;
        }
        if (source !== current) return;
      }
    }
    if (source !== current) return;
    for (const conversation of current.conversations)
      if (!permitted(conversation.id)) revoke(conversation.id);
  }
  function capture(
    message: Message | PartialMessage,
    op: "upsert" | "delete",
    isUpdate = false,
  ) {
    if (
      !source ||
      !queue ||
      client.user?.id !== source.accountId ||
      !client.isReady()
    )
      return;
    if (!permitted(message.channelId)) {
      if (source.conversations.some((c) => c.id === message.channelId))
        revoke(message.channelId);
      return;
    }
    // Never fetch a partial update: only content actually delivered by Discord is mapped.
    const event = metadata.observe(source, message, op, Date.now(), isUpdate);
    if (event) {
      if (isUpdate && event.op === "delete") {
        queue.connected(false);
        console.error("BOT_PARTIAL_UPDATE_BODY_REMOVED");
      }
      queue.capture(event);
    }
  }
  async function history() {
    const current = source;
    if (
      !current?.enabled ||
      client.user?.id !== current.accountId ||
      !client.isReady()
    )
      return;
    for (const conversation of current.conversations) {
      try {
        const channel = await client.channels.fetch(conversation.id);
        if (source !== current) return;
        if (
          !channel ||
          channel.type !== ChannelType.GuildText ||
          !permitted(conversation.id)
        ) {
          revoke(conversation.id);
          continue;
        }
        if (!historyLimit) continue;
        const messages = await channel.messages.fetch({ limit: historyLimit });
        if (source !== current) return;
        for (const message of messages.values())
          if (message.createdTimestamp >= Date.now() - retentionMs)
            capture(message, "upsert");
      } catch (error) {
        if (accessLost(error)) revoke(conversation.id);
        queue?.connected(false);
        console.error("BOT_HISTORY_UNAVAILABLE");
      }
    }
  }
  async function tick() {
    if (busy || closed) return;
    busy = true;
    try {
      const response = await request("/v1/producer-scope");
      const payload = (await response.json()) as { sources: unknown[] };
      const next = payload.sources
        .map((s) => sourceSchema.parse(s))
        .find((s) => s.id === sourceId && s.type === "bot");
      if (!next) {
        metadata.clear();
        queue?.purge();
        source = undefined;
        signature = "";
        return;
      }
      const nextSignature = JSON.stringify(next);
      let changed = false;
      if (nextSignature !== signature) {
        signature = nextSignature;
        source = {
          ...next,
          conversations: next.conversations.filter((c) => !revoked.has(c.id)),
        };
        metadata.clear();
        if (queue) queue.configure(source);
        else queue = new DeliveryQueue(source);
        changed = true;
      }
      if (!source || !queue) return;
      if (!source.enabled || client.user?.id !== source.accountId) {
        metadata.clear();
        queue.pause();
        return;
      }
      queue.pause(false);
      queue.connected(client.isReady());
      if (changed) await history();
      await checkPermissions(true);
      for (const [conversationId, old] of pending) {
        await request("/v1/source-control", {
          sourceId: old.id,
          accountId: old.accountId,
          generation: next.generation,
          action: "revoke",
          conversationId,
        });
        pending.delete(conversationId);
        // Revocation increments server generation. Obtain a fresh scope before exporting.
        metadata.clear();
        queue.purge();
        signature = "";
        return;
      }
      if (client.isReady())
        await queue.flush(async (events, health, signal) => {
          await request("/v1/ingest", { events, health }, signal);
        });
    } catch {
      metadata.clear();
      queue?.purge();
      signature = "";
      console.error("BOT_BRIDGE_UNAVAILABLE");
    } finally {
      busy = false;
    }
  }
  client.on(Events.MessageCreate, (message) => capture(message, "upsert"));
  client.on(Events.MessageUpdate, (_old, message) =>
    capture(message, "upsert", true),
  );
  client.on(Events.MessageDelete, (message) => capture(message, "delete"));
  client.on(Events.MessageBulkDelete, (messages) => {
    for (const message of messages.values()) capture(message, "delete");
  });
  client.on(Events.ClientReady, () => {
    console.info("BOT_CONNECTED");
    signature = "";
    void tick();
  });
  client.on(Events.ShardResume, () => {
    queue?.connected(true);
    void history();
  });
  client.on(Events.ShardDisconnect, () => queue?.connected(false));
  client.on(Events.ShardReconnecting, () => queue?.connected(false));
  client.on(Events.ChannelUpdate, () => {
    void checkPermissions().catch(() => queue?.pause());
  });
  client.on(Events.ChannelDelete, (channel) => revoke(channel.id));
  client.on(Events.GuildDelete, (guild) => {
    for (const c of source?.conversations ?? [])
      if (c.guildId === guild.id) revoke(c.id);
  });
  client.on(Events.GuildRoleUpdate, () => {
    void checkPermissions().catch(() => queue?.pause());
  });
  client.on(Events.GuildRoleDelete, () => {
    void checkPermissions().catch(() => queue?.pause());
  });
  client.on(Events.Error, () => {
    queue?.connected(false);
    console.error("BOT_GATEWAY_ERROR");
  });
  client.on(Events.ShardError, () => {
    queue?.connected(false);
    console.error("BOT_GATEWAY_ERROR");
  });
  const exporter = setInterval(() => void tick(), 10000);
  const permissions = setInterval(() => {
    void checkPermissions(true).catch(() => queue?.pause());
  }, 30000);
  const stop = () => {
    closed = true;
    clearInterval(exporter);
    clearInterval(permissions);
    metadata.clear();
    queue?.purge();
    client.destroy();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await client.login(botToken);
  } catch {
    stop();
    throw new Error("BOT_LOGIN_FAILED");
  }
}
main().catch(() => {
  console.error("BOT_START_FAILED");
  process.exitCode = 1;
});
