import { z } from "zod";
export const MAX_INGEST_BYTES = 1024 * 1024;
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const timestamp = z.number().int().nonnegative().max(8640000000000000);
export const sourceSchema = z
  .object({
    id,
    type: z.enum(["bot", "personal"]),
    accountId: id,
    enabled: z.boolean().default(false),
    generation: z.number().int().positive().default(1),
    conversations: z.array(z.object({ id, guildId: id.optional() })).max(100),
  })
  .strict();
export type Source = z.infer<typeof sourceSchema>;
const base = {
  eventId: id,
  sourceId: id,
  accountId: id,
  conversationId: id,
  generation: z.number().int().positive(),
  messageId: id,
  observedAt: timestamp,
  revision: timestamp,
};
export const eventSchema = z.discriminatedUnion("op", [
  z
    .object({
      ...base,
      op: z.literal("upsert"),
      createdAt: timestamp,
      authorId: id,
      text: z.string().max(8000),
    })
    .strict(),
  z
    .object({
      ...base,
      op: z.literal("delete"),
      reason: z.literal("unavailable_edit").optional(),
    })
    .strict(),
]);
export type Observation = z.infer<typeof eventSchema>;
export const healthSchema = z
  .object({
    sourceId: id,
    accountId: id,
    generation: z.number().int().positive(),
    connected: z.boolean(),
    paused: z.boolean(),
    lastObservedAt: timestamp.nullable(),
    gapSince: timestamp.nullable(),
    overflow: z.number().int().nonnegative(),
    queueDepth: z.number().int().min(0).max(10000),
  })
  .strict();
export type SourceHealth = z.infer<typeof healthSchema>;
export const readSchema = z
  .object({
    sourceId: id.optional(),
    conversationId: id.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().uuid().optional(),
    query: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ReadInput = z.input<typeof readSchema>;
export type Principal = {
  subject: string;
  ownerId: string;
  role: "reader" | "producer";
  expiresAt?: number;
  sourceIds: string[];
  conversationIds?: string[];
};
export class BridgeError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export const coverage = [
  "Only observed/allowed messages; never a complete inbox.",
  "Offline deletions may be unknown.",
  "Changes contain current content, not historical bodies.",
];
export function allowed(
  source: Source,
  accountId: string,
  conversationId: string,
  generation: number,
) {
  return (
    source.enabled &&
    source.accountId === accountId &&
    source.generation === generation &&
    source.conversations.some((c) => c.id === conversationId)
  );
}
export function sourceLink(
  source: Source,
  conversationId: string,
  messageId: string,
) {
  const conv = source.conversations.find((c) => c.id === conversationId);
  return `https://discord.com/channels/${source.type === "bot" ? conv?.guildId : "@me"}/${conversationId}/${messageId}`;
}
// A narrow defense in depth; no claim of comprehensive redaction.
export function sanitizeText(text: string) {
  return text.replace(
    /(?:mfa\.[\w-]{20,}|[\w-]{24,}\.[\w-]{6,}\.[\w-]{25,}|(?:sk-|ghp_)[\w-]{20,})/g,
    "[potential secret removed]",
  );
}
