import test from "node:test";
import assert from "node:assert/strict";
import { planControlRetry } from "../packages/plugin/src/core.js";
import { Store } from "../packages/service/src/store.js";
import { config, event, now, producer, reader, source } from "./fixtures.js";
import type { Source } from "../packages/domain/src/index.js";
function fixture(run: (store: Store) => void) {
  const store = new Store(config(), () => now);
  try {
    run(store);
  } finally {
    store.close();
  }
}
function scoped(store: Store, restricted = false) {
  return store.producerScope(
    restricted ? { ...producer, conversationIds: ["selected-b"] } : producer,
  );
}
function command(
  generation: number,
  action: "purge" | "revoke",
  conversationId?: string,
) {
  return {
    sourceId: source.id,
    accountId: source.accountId,
    generation,
    action,
    ...(conversationId ? { conversationId } : {}),
  };
}
test("lost targeted revoke response reconciles only from newer complete authorized scope", () =>
  fixture((store) => {
    store.control(producer, command(1, "revoke", "selected-a")); // response deliberately discarded
    const complete = scoped(store);
    assert.deepEqual(
      planControlRetry(
        source,
        "revoke",
        "selected-a",
        complete.sources[0],
        complete.conversationScopeComplete,
      ),
      { state: "acknowledged" },
    );
    const filtered = scoped(store, true);
    assert.deepEqual(
      planControlRetry(
        source,
        "revoke",
        "selected-a",
        filtered.sources[0],
        filtered.conversationScopeComplete,
      ),
      { state: "blocked" },
    );
  }));
test("filtered absence and unrelated generation changes never confirm a global revoke", () =>
  fixture((store) => {
    store.control(producer, command(1, "purge", "selected-b"));
    const projected = scoped(store, true);
    assert.deepEqual(
      planControlRetry(
        source,
        "revoke",
        "selected-a",
        projected.sources[0],
        projected.conversationScopeComplete,
      ),
      { state: "blocked" },
    );
    const complete = scoped(store);
    const retry = planControlRetry(
      source,
      "revoke",
      "selected-a",
      complete.sources[0],
      true,
    );
    assert.deepEqual(retry, { state: "send", generation: 2 });
    if (retry.state === "send")
      store.control(
        producer,
        command(retry.generation, "revoke", "selected-a"),
      );
    assert.equal(
      planControlRetry(
        source,
        "revoke",
        "selected-a",
        scoped(store).sources[0],
        true,
      ).state,
      "acknowledged",
    );
  }));
test("lost whole-source revoke response reconciles disabled matching source but fails closed on filtered or absent source", () =>
  fixture((store) => {
    store.control(producer, command(1, "revoke"));
    const complete = scoped(store);
    assert.equal(
      planControlRetry(source, "revoke", undefined, complete.sources[0], true)
        .state,
      "acknowledged",
    );
    assert.equal(
      planControlRetry(
        source,
        "revoke",
        undefined,
        scoped(store, true).sources[0],
        false,
      ).state,
      "blocked",
    );
    assert.equal(
      planControlRetry(source, "revoke", undefined, undefined, true).state,
      "blocked",
    );
  }));
test("explicit purge retry uses fresh generation and actually purges newer content; generation is never a purge acknowledgement", () =>
  fixture((store) => {
    store.ingest(producer, [event()]);
    store.control(producer, command(1, "purge")); // successful operation, lost response
    store.ingest(producer, [
      event({
        generation: 2,
        eventId: "after-purge",
        messageId: "after-purge",
        text: "Synthetic new observation",
      }),
    ]);
    const complete = scoped(store);
    const retry = planControlRetry(
      source,
      "purge",
      undefined,
      complete.sources[0],
      true,
    );
    assert.deepEqual(retry, { state: "send", generation: 2 });
    if (retry.state === "send")
      store.control(producer, command(retry.generation, "purge"));
    const page = store.execute(reader, "read_messages", {
      sourceId: source.id,
    }) as { items: unknown[] };
    assert.equal(page.items.length, 0);
    assert.deepEqual(
      planControlRetry(
        source,
        "purge",
        undefined,
        scoped(store).sources[0],
        true,
      ),
      { state: "send", generation: 3 },
    );
  }));
test("purge retries cannot widen original scope or rely on filtered whole-source selection", () =>
  fixture((store) => {
    const projected = scoped(store, true);
    const originalProjected = {
      ...source,
      conversations: [{ id: "selected-b" }],
    };
    assert.equal(
      planControlRetry(
        originalProjected,
        "purge",
        undefined,
        projected.sources[0],
        false,
      ).state,
      "blocked",
    );
    assert.deepEqual(
      planControlRetry(
        source,
        "purge",
        "selected-b",
        projected.sources[0],
        false,
      ),
      { state: "send", generation: 1 },
    );
    assert.equal(
      planControlRetry(
        source,
        "purge",
        "selected-a",
        projected.sources[0],
        false,
      ).state,
      "blocked",
    );
    store.applyScopes([
      {
        ...source,
        conversations: [...source.conversations, { id: "new-conversation" }],
      },
    ]);
    const widened = scoped(store).sources[0];
    assert.equal(
      planControlRetry(source, "purge", undefined, widened, true).state,
      "blocked",
    );
    assert.equal(
      planControlRetry(source, "revoke", undefined, widened, true).state,
      "blocked",
    );
  }));
test("retry identity, original selection and generation remain mandatory even for disabled source", () => {
  const newer = { ...source, generation: 2, enabled: false };
  for (const remote of [
    { ...newer, accountId: "different" },
    { ...newer, id: "different" },
    { ...newer, type: "bot" as const },
    { ...newer, generation: 0 },
  ])
    assert.equal(
      planControlRetry(source, "revoke", undefined, remote, true).state,
      "blocked",
    );
  assert.equal(
    planControlRetry(source, "purge", "unselected", newer, true).state,
    "blocked",
  );
  const changedAccount = { ...newer, accountId: "different" } as Source;
  assert.equal(
    planControlRetry(source, "purge", undefined, changedAccount, true).state,
    "blocked",
  );
});
