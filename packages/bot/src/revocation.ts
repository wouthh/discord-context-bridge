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
): Promise<boolean> {
  for (const [conversationId, previous] of pending) {
    if (
      refreshed.id !== previous.id ||
      refreshed.accountId !== previous.accountId ||
      refreshed.type !== previous.type
    )
      throw new Error("BOT_REVOCATION_IDENTITY_MISMATCH");
    // A committed control response may be lost. Only a newer authenticated
    // matching scope with the conversation absent confirms remote revocation.
    if (
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
