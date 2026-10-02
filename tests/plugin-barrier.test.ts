import test from "node:test";
import assert from "node:assert/strict";
import {
  createControlBarrier,
  parseControlBarrier,
  confirmControlBarrier,
  controlBarrierMinimum,
  planControlRetry,
} from "../packages/plugin/src/core.js";
import { Store } from "../packages/service/src/store.js";
import {
  config,
  event,
  now,
  source,
  producer,
  reader,
  producerToken,
} from "./fixtures.js";
const endpoint = "https://connector.example.invalid";
function fixture(run: (store: Store) => void) {
  const store = new Store(config(), () => now);
  try {
    run(store);
  } finally {
    store.close();
  }
}
const restart = (value: ReturnType<typeof createControlBarrier>) =>
  parseControlBarrier(JSON.stringify(value))!;
function items(store: Store) {
  return (store.execute(reader, "read_messages") as { items: unknown[] }).items;
}
function runPending(
  store: Store,
  barrier: ReturnType<typeof createControlBarrier>,
) {
  const scope = store.producerScope(producer),
    remote = scope.sources.find((s) => s.id === barrier.original.id);
  const plan = planControlRetry(
    barrier.original,
    barrier.action,
    barrier.conversationId,
    remote,
    scope.conversationScopeComplete,
  );
  assert.equal(plan.state, "send");
  if (plan.state !== "send") throw new Error("expected synthetic retry");
  const result = store.control(producer, {
    sourceId: barrier.original.id,
    accountId: barrier.original.accountId,
    generation: plan.generation,
    action: barrier.action,
    ...(barrier.conversationId
      ? { conversationId: barrier.conversationId }
      : {}),
  });
  return confirmControlBarrier(barrier, result.source.generation);
}
for (const target of [undefined, "selected-a"])
  test(`uncommitted ${target ? "targeted" : "whole-source"} revoke survives restart and unrelated generation change`, () =>
    fixture((store) => {
      store.ingest(producer, [event()]);
      const barrier = restart(
        createControlBarrier(source, "revoke", endpoint, target),
      ); // original request never committed
      store.control(producer, {
        sourceId: source.id,
        accountId: source.accountId,
        generation: 1,
        action: "purge",
        conversationId: "selected-b",
      });
      const current = store.producerScope(producer).sources[0];
      assert.equal(items(store).length, 1);
      assert.throws(
        () => controlBarrierMinimum(barrier, current, endpoint),
        /control_unconfirmed/,
      );
      const confirmed = restart(runPending(store, barrier));
      assert.equal(confirmed.confirmed, true);
      assert.equal(confirmed.minimumGeneration, 3);
      assert.equal(items(store).length, 0);
      assert.equal(
        controlBarrierMinimum(
          confirmed,
          { ...source, generation: 3 },
          endpoint,
        ),
        3,
      );
    }));
test("uncommitted purge persists across restart; unrelated generation is never confirmation", () =>
  fixture((store) => {
    store.ingest(producer, [event()]);
    const barrier = restart(createControlBarrier(source, "purge", endpoint));
    store.control(producer, {
      sourceId: source.id,
      accountId: source.accountId,
      generation: 1,
      action: "purge",
      conversationId: "selected-b",
    });
    const current = store.producerScope(producer).sources[0];
    assert.equal(items(store).length, 1);
    assert.throws(
      () => controlBarrierMinimum(barrier, current, endpoint),
      /control_unconfirmed/,
    );
    const confirmed = restart(runPending(store, barrier));
    assert.equal(confirmed.confirmed, true);
    assert.equal(confirmed.minimumGeneration, 3);
    assert.equal(items(store).length, 0);
  }));
test("persisted original control excludes credentials/content and globally blocks changed configuration until confirmed", () => {
  const barrier = restart(
    createControlBarrier(source, "revoke", endpoint, "selected-a"),
  );
  const serialized = JSON.stringify(barrier);
  for (const value of [
    producerToken,
    "key",
    "token",
    "Synthetic message text",
    "text",
    "body",
  ])
    assert.equal(serialized.includes(value), false);
  assert.deepEqual(barrier.original, source);
  assert.equal(barrier.conversationId, "selected-a");
  assert.throws(
    () =>
      controlBarrierMinimum(
        barrier,
        { ...source, id: "new-source", accountId: "different" },
        "https://different.example.invalid",
      ),
    /control_unconfirmed/,
  );
  const confirmed = confirmControlBarrier(barrier, 4);
  assert.equal(controlBarrierMinimum(confirmed, source, endpoint), 4);
  assert.equal(
    controlBarrierMinimum(confirmed, { ...source, id: "new-source" }, endpoint),
    0,
  );
  assert.equal(
    controlBarrierMinimum(
      confirmed,
      source,
      "https://different.example.invalid",
    ),
    0,
  );
});
test("empty metadata is initial state; malformed, legacy, incomplete or secret-bearing metadata fails closed", () => {
  assert.equal(parseControlBarrier(""), null);
  const complete = createControlBarrier(source, "purge", endpoint);
  const missingOriginalGeneration = {
    ...complete,
    original: { ...source },
  } as { original: { generation?: number } };
  delete missingOriginalGeneration.original.generation;
  const credentialOrigin = new URL(endpoint);
  credentialOrigin.username = "synthetic-user";
  credentialOrigin.password = "synthetic-password";
  for (const value of [
    "{",
    "null",
    JSON.stringify({ sourceId: source.id, endpoint, generation: 2 }),
    JSON.stringify({ ...complete, confirmed: undefined }),
    JSON.stringify(missingOriginalGeneration),
    JSON.stringify({ ...complete, key: producerToken }),
    JSON.stringify({ ...complete, original: { ...source, text: "unallowed" } }),
    JSON.stringify({
      ...complete,
      endpoint: credentialOrigin.href,
    }),
  ])
    assert.throws(() => parseControlBarrier(value));
  assert.throws(
    () => confirmControlBarrier(complete, source.generation),
    /control_generation_unconfirmed/,
  );
});
test("restart reconciliation still rejects a grant-filtered view and changed identity", () =>
  fixture((store) => {
    const barrier = restart(
      createControlBarrier(source, "revoke", endpoint, "selected-a"),
    );
    store.control(producer, {
      sourceId: source.id,
      accountId: source.accountId,
      generation: 1,
      action: "purge",
      conversationId: "selected-b",
    });
    const filtered = store.producerScope({
      ...producer,
      conversationIds: ["selected-b"],
    });
    assert.equal(
      planControlRetry(
        barrier.original,
        barrier.action,
        barrier.conversationId,
        filtered.sources[0],
        filtered.conversationScopeComplete,
      ).state,
      "blocked",
    );
    const changed = {
      ...store.producerScope(producer).sources[0],
      accountId: "different",
    };
    assert.equal(
      planControlRetry(
        barrier.original,
        barrier.action,
        barrier.conversationId,
        changed,
        true,
      ).state,
      "blocked",
    );
  }));
