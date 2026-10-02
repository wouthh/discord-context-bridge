import type { Source } from "../../domain/src/index.js";
type RevokeRequest = {
  sourceId: string;
  accountId: string;
  generation: number;
  action: "revoke";
  conversationId: string;
};
/** Returns true only when a new control request needs another scope refresh. */
export async function processPendingRevocations(
  pending: Map<string, Source>,
  refreshed: Source,
  send: (request: RevokeRequest) => Promise<void>,
  conversationScopeComplete = false,
): Promise<boolean> {
  for (const [conversationId, previous] of pending) {
    if (
      refreshed.id !== previous.id ||
      refreshed.accountId !== previous.accountId ||
      refreshed.type !== previous.type
    )
      throw new Error("BOT_REVOCATION_IDENTITY_MISMATCH");
    // A committed control response may be lost. Only a newer authenticated
    // matching complete conversation scope can establish absence. A filtered
    // producer grant may hide a still-selected conversation and cannot confirm it.
    if (
      conversationScopeComplete === true &&
      refreshed.generation > previous.generation &&
      !refreshed.conversations.some((c) => c.id === conversationId)
    ) {
      pending.delete(conversationId);
      continue;
    }
    await send({
      sourceId: previous.id,
      accountId: previous.accountId,
      generation: refreshed.generation,
      action: "revoke",
      conversationId,
    });
    pending.delete(conversationId);
    return true;
  }
  return false;
}

/** Ignore stale async results and channels absent from the current selection. */
export function beginRevocation(
  current: Source | undefined,
  conversationId: string,
  revoked: Set<string>,
  pending: Map<string, Source>,
  expected: Source | undefined = current,
): Source | null {
  if (
    !current ||
    current !== expected ||
    revoked.has(conversationId) ||
    !current.conversations.some((c) => c.id === conversationId)
  )
    return null;
  revoked.add(conversationId);
  pending.set(conversationId, current);
  return {
    ...current,
    conversations: current.conversations.filter((c) => c.id !== conversationId),
  };
}

/** Validate a captured guild result once, then remove its current channels synchronously. */
export function beginGuildRevocation(
  current: Source | undefined,
  guildId: string,
  revoked: Set<string>,
  pending: Map<string, Source>,
  expected: Source | undefined = current,
): Source | null {
  if (!current || current !== expected) return null;
  let next = current;
  for (const conversation of current.conversations) {
    if (conversation.guildId !== guildId) continue;
    next = beginRevocation(next, conversation.id, revoked, pending) ?? next;
  }
  return next === current ? null : next;
}
