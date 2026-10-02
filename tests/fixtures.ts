import { configSchema } from "../packages/service/src/config.js";
import { tokenHash } from "../packages/service/src/auth.js";
import type {
  Observation,
  Principal,
  Source,
} from "../packages/domain/src/index.js";
export const now = 1700000000000;
export const source: Source = {
  id: "personal-client",
  type: "personal",
  accountId: "account-a",
  enabled: true,
  generation: 1,
  conversations: [{ id: "selected-a" }, { id: "selected-b" }],
};
export const reader: Principal = {
  subject: "synthetic-reader",
  ownerId: "synthetic-owner",
  role: "reader",
  sourceIds: [source.id],
};
export const producer: Principal = {
  ...reader,
  subject: "synthetic-producer",
  role: "producer",
};
export const readerToken = "synthetic-reader-credential";
export const producerToken = "synthetic-producer-credential";
export function config(database = ":memory:") {
  return configSchema.parse({
    ownerId: reader.ownerId,
    database,
    sources: [source],
    auth: {
      mode: "local",
      credentials: [
        {
          subject: reader.subject,
          role: reader.role,
          sourceIds: reader.sourceIds,
          tokenHash: tokenHash(readerToken),
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
        },
        {
          subject: producer.subject,
          role: producer.role,
          sourceIds: producer.sourceIds,
          tokenHash: tokenHash(producerToken),
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
        },
      ],
    },
  });
}
export function event(overrides: Partial<Observation> = {}): Observation {
  return {
    op: "upsert",
    eventId: "synthetic-event",
    sourceId: source.id,
    accountId: source.accountId,
    generation: 1,
    conversationId: "selected-a",
    messageId: "synthetic-message",
    createdAt: now - 1000,
    revision: now - 1000,
    observedAt: now,
    authorId: "synthetic-author",
    text: "Synthetic message text",
    ...overrides,
  } as Observation;
}
