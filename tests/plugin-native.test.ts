import test from "node:test";
import assert from "node:assert/strict";
const { request } = (await import(
  new URL("../packages/plugin/src/native.ts", import.meta.url).href
)) as {
  request: (
    event: unknown,
    origin: string,
    token: string,
    path: string,
    payload?: string,
  ) => Promise<unknown>;
};
test("native export applies 1MiB UTF8 ceiling before network and accepts the exact ASCII boundary", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("", { status: 200 });
  };
  try {
    await assert.rejects(
      request(
        undefined,
        "http://127.0.0.1:8787",
        "synthetic-session-key",
        "/v1/ingest",
        "界".repeat(400000),
      ),
      /invalid_export/,
    );
    assert.equal(calls, 0);
    await request(
      undefined,
      "http://127.0.0.1:8787",
      "synthetic-session-key",
      "/v1/ingest",
      "x".repeat(1024 * 1024),
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previous;
  }
});
