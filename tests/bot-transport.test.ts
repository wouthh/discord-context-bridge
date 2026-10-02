import test from "node:test";
import assert from "node:assert/strict";
import { DeliveryQueue } from "../packages/sources/src/queue.js";
import { requestWithDeadline } from "../packages/bot/src/transport.js";
import { source, event, now } from "./fixtures.js";

function stalledFetch(onStart: (signal: AbortSignal) => void): typeof fetch {
  return async (_url, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => {
      const watchdog = setTimeout(
        () => reject(new Error("synthetic-deadline-missing")),
        1000,
      );
      const abort = () => {
        clearTimeout(watchdog);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      onStart(signal);
      if (signal.aborted) abort();
    });
  };
}

test("stalled ingest times out with a queue signal and releases the busy export for retry", async () => {
  let clock = now;
  const queue = new DeliveryQueue(source, 500, 3600000, () => clock);
  queue.pause(false);
  queue.connected(true);
  queue.capture(event());
  let queueSignal: AbortSignal | undefined;
  let combined: AbortSignal | undefined;
  await queue.flush(async (events, health, signal) => {
    queueSignal = signal;
    await requestWithDeadline(
      new URL("http://127.0.0.1:8787/v1/ingest"),
      {
        method: "POST",
        body: JSON.stringify({ events, health }),
        signal,
      },
      20,
      stalledFetch((value) => {
        combined = value;
      }),
    );
  });
  assert.equal(queueSignal?.aborted, false);
  assert.equal(combined?.aborted, true);
  assert.equal(combined?.reason.name, "TimeoutError");
  assert.equal(queue.status().queueDepth, 1);
  clock += 3000;
  let retried = false;
  await queue.flush(async (_events, _health, signal) => {
    await requestWithDeadline(
      new URL("http://127.0.0.1:8787/v1/ingest"),
      { signal },
      20,
      async () => {
        retried = true;
        return new Response("{}", { status: 200 });
      },
    );
  });
  assert.equal(retried, true);
  assert.equal(queue.status().queueDepth, 0);
});

test("pause aborts a stalled ingest before its deadline and export resumes after explicit restart", async () => {
  const queue = new DeliveryQueue(source, 500, 3600000, () => now);
  queue.pause(false);
  queue.capture(event());
  let combined: AbortSignal | undefined;
  await queue.flush(async (_events, _health, signal) => {
    await requestWithDeadline(
      new URL("http://127.0.0.1:8787/v1/ingest"),
      { signal },
      10000,
      stalledFetch((value) => {
        combined = value;
        queue.pause();
      }),
    );
  });
  assert.equal(combined?.aborted, true);
  assert.equal(combined?.reason.name, "AbortError");
  assert.equal(queue.status().queueDepth, 0);
  queue.pause(false);
  queue.capture(event({ eventId: "synthetic-after-pause" }));
  let exported = 0;
  await queue.flush(async (events) => {
    exported = events.length;
  });
  assert.equal(exported, 1);
  assert.equal(queue.status().queueDepth, 0);
});
