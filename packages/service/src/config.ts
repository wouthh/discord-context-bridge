import { z } from "zod";
import { readFileSync } from "node:fs";
import { sourceSchema, id } from "../../domain/src/index.js";
const grant = z
  .object({
    subject: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\s\x00-\x1f]+$/),
    role: z.enum(["reader", "producer"]),
    sourceIds: z.array(id).max(100),
    conversationIds: z.array(id).max(100).optional(),
  })
  .strict();
export const configSchema = z
  .object({
    ownerId: id,
    port: z.number().int().min(1024).max(65535).default(8787),
    publicUrl: z.string().url().default("http://127.0.0.1:8787"),
    remote: z.boolean().default(false),
    origins: z.array(z.string().url()).default([]),
    database: z.string().min(1),
    retentionDays: z.number().int().min(1).max(30).default(7),
    cursorTtlSeconds: z.number().int().min(60).max(3600).default(900),
    sources: z.array(sourceSchema).max(100),
    auth: z.discriminatedUnion("mode", [
      z
        .object({
          mode: z.literal("local"),
          credentials: z
            .array(
              grant.extend({
                tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
                expiresAt: z.number().int().positive(),
              }),
            )
            .max(100),
        })
        .strict(),
      z
        .object({
          mode: z.literal("jwt"),
          issuer: z.string().url(),
          jwksUrl: z.string().url(),
          readerAudience: z.string().url(),
          producerAudience: z.string().url(),
          grants: z.array(grant).max(100),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((c, ctx) => {
    const u = new URL(c.publicUrl);
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.pathname !== "/" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      ctx.addIssue({ code: "custom", message: "unsafe_url" });
    if (c.remote && (u.protocol !== "https:" || c.auth.mode !== "jwt"))
      ctx.addIssue({ code: "custom", message: "remote_requires_https_jwt" });
    if (!c.remote && !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))
      ctx.addIssue({ code: "custom", message: "local_requires_loopback" });
    if (
      c.auth.mode === "jwt" &&
      c.auth.readerAudience === c.auth.producerAudience
    )
      ctx.addIssue({ code: "custom", message: "audiences_must_differ" });
    if (
      c.auth.mode === "jwt" &&
      [
        c.auth.issuer,
        c.auth.jwksUrl,
        c.auth.readerAudience,
        c.auth.producerAudience,
      ].some((v) => new URL(v).protocol !== "https:")
    )
      ctx.addIssue({ code: "custom", message: "jwt_requires_https" });
    if (new Set(c.sources.map((s) => s.id)).size !== c.sources.length)
      ctx.addIssue({ code: "custom", message: "duplicate_source" });
    for (const s of c.sources) {
      if (
        new Set(s.conversations.map((v) => v.id)).size !==
          s.conversations.length ||
        s.conversations.some((v) =>
          s.type === "bot" ? !v.guildId : !!v.guildId,
        )
      )
        ctx.addIssue({ code: "custom", message: "invalid_conversation_scope" });
    }
    const grants = c.auth.mode === "local" ? c.auth.credentials : c.auth.grants;
    if (
      new Set(grants.map((g) => `${g.role}:${g.subject}`)).size !==
      grants.length
    )
      ctx.addIssue({ code: "custom", message: "duplicate_grant" });
  });
export type Config = z.infer<typeof configSchema>;
export function loadConfig() {
  try {
    return configSchema.parse(
      JSON.parse(readFileSync(process.env.BRIDGE_CONFIG ?? "", "utf8")),
    );
  } catch {
    throw new Error("configuration_invalid");
  }
}
