import { test } from "node:test";
import assert from "node:assert/strict";
import { DeliveryQueue } from "../packages/sources/src/queue.js";
import { event, source, now } from "./fixtures.js";
test("queue allowlists, starts paused, account and generation enforced", () => {
  const q = new DeliveryQueue(source, 2, 1000, () => now);
  assert(!q.capture(event()));
  q.pause(false);
  assert(!q.capture(event({ conversationId: "excluded" })));
  assert(!q.capture(event({ accountId: "wrong" })));
  assert(q.capture(event()));
  q.configure({ ...source, generation: 2 });
  q.pause(false);
  assert.equal(q.status().queueDepth, 0);
  assert(!q.capture(event()));
});
test("coalescing edits, deletion clears queued body, overflow and TTL report coverage gaps", async () => {
  let clock = now;
  const q = new DeliveryQueue(source, 2, 1000, () => clock);
  q.pause(false);
  q.capture(event());
  q.capture(event({ eventId: "edit", revision: now, text: "Synthetic edit" }));
  assert.equal(q.status().queueDepth, 1);
  q.capture({
    op: "delete",
    eventId: "delete",
    sourceId: source.id,
    accountId: source.accountId,
    conversationId: "selected-a",
    messageId: "synthetic-message",
    generation: 1,
    observedAt: now,
    revision: now,
  });
  let sent: unknown;
  await q.flush(async (e) => {
    sent = e;
  });
  assert(!JSON.stringify(sent).includes("Synthetic edit"));
  for (let i = 0; i < 3; i++)
    q.capture(event({ eventId: `e${i}`, messageId: `m${i}` }));
  assert.equal(q.status().queueDepth, 2);
  assert.equal(q.status().overflow, 1);
  clock += 1001;
  assert.equal(q.status().queueDepth, 0);
  assert.equal(q.status().overflow, 3);
});
test("bounded retry, single flight, pause abort and deselection cannot acknowledge new queue", async () => {
  let clock = now;
  const q = new DeliveryQueue(source, 2, 10000, () => clock);
  q.pause(false);
  q.capture(event());
  let tries = 0;
  await q.flush(async () => {
    tries++;
    throw new Error("synthetic network failure");
  });
  await q.flush(async () => {
    tries++;
  });
  assert.equal(tries, 1);
  clock += 2000;
  let release: () => void = () => {};
  let signal: AbortSignal | undefined;
  const flight = q.flush(async (_events, _health, s) => {
    signal = s;
    await new Promise<void>((r) => {
      release = r;
    });
  });
  await q.flush(async () => {
    tries++;
  });
  assert.equal(tries, 1);
  q.configure({
    ...source,
    conversations: [{ id: "selected-b" }],
    generation: 2,
  });
  assert(signal?.aborted);
  q.pause(false);
  q.capture(
    event({ eventId: "new", conversationId: "selected-b", generation: 2 }),
  );
  release();
  await flight;
  assert.equal(q.status().queueDepth, 1);
});
