import { loadConfig } from "./config.js";
import { Store } from "./store.js";
process.umask(0o077);
let store: Store | undefined;
try {
  const config = await loadConfig();
  store = new Store(config);
  const action = process.argv[2];
  if (action === "apply-scopes") {
    store.applyScopes(config.sources);
    console.info("scopes_applied_generations_changed");
  } else if (action === "status") {
    console.info(
      JSON.stringify({
        sources: store.sources().map((s) => ({
          id: s.id,
          generation: s.generation,
          enabled: s.enabled,
          selected: s.conversations.length,
        })),
      }),
    );
  } else if (action === "revoke" || action === "purge") {
    const source = store.sources().find((s) => s.id === process.argv[3]);
    if (!source) throw new Error();
    store.control(
      {
        subject: "local-owner",
        ownerId: config.ownerId,
        role: "producer",
        sourceIds: [source.id],
      },
      {
        sourceId: source.id,
        accountId: source.accountId,
        generation: source.generation,
        action,
        conversationId: process.argv[4],
      },
    );
    console.info("source_control_applied");
  } else throw new Error();
} catch {
  console.error("control_failed");
  process.exitCode = 1;
} finally {
  store?.close();
}
