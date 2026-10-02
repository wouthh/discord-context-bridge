import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readHttp } from "../examples/http-client.js";
import { readMcp } from "../examples/mcp-client.js";
import { Store } from "../packages/service/src/store.js";
import { createApp } from "../packages/service/src/http.js";
import { DeliveryQueue } from "../packages/sources/src/queue.js";
import { MAX_INGEST_BYTES } from "../packages/domain/src/index.js";
import {
  config,
  event,
  readerToken,
  producerToken,
  now,
  source,
} from "./fixtures.js";
async function start() {
  const s = new Store(config(), () => now);
  const server = createApp(s).listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  s.config.port = port;
  s.config.publicUrl = `http://127.0.0.1:${port}`;
  return {
    s,
    url: s.config.publicUrl,
    close: async () => {
      server.close();
      await once(server, "close");
      s.close();
    },
  };
}
async function request(
  url: string,
  route: string,
  token?: string,
  body: unknown = {},
) {
  return fetch(new URL(route, url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
test("real HTTP and SDK Streamable HTTP read identical scoped content and reject role swapping", async () => {
  const run = await start();
  const client = new Client({ name: "synthetic-client", version: "1.0" });
  try {
    assert.equal((await request(run.url, "/v1/read_messages")).status, 401);
    assert.equal(
      (await request(run.url, "/v1/ingest", readerToken, { events: [event()] }))
        .status,
      401,
    );
    assert.equal(
      (await request(run.url, "/v1/read_messages", producerToken)).status,
      401,
    );
    const ingest = await request(run.url, "/v1/ingest", producerToken, {
      events: [event()],
    });
    assert.equal(ingest.status, 200);
    assert.deepEqual(
      await readHttp(run.url, readerToken),
      await readMcp(run.url, readerToken),
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", run.url), {
        requestInit: { headers: { Authorization: `Bearer ${readerToken}` } },
      }),
    );
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 5);
    assert(!JSON.stringify(tools).includes("Synthetic message"));
    const result = await client.callTool({
      name: "read_messages",
      arguments: { sourceId: source.id },
    });
    const content = (result.content as { type: string; text: string }[])[0];
    const http = await (
      await request(run.url, "/v1/read_messages", readerToken, {
        sourceId: source.id,
      })
    ).json();
    assert.deepEqual(JSON.parse(content.text), http);
    const denied = await client.callTool({
      name: "read_messages",
      arguments: { sourceId: source.id, conversationId: "excluded" },
    });
    assert.equal(denied.isError, true);
    assert.equal(
      (
        await request(run.url, "/v1/read_messages", readerToken, {
          sourceId: source.id,
          conversationId: "excluded",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(run.url, "/v1/ingest", producerToken, {
          events: [{ ...event(), ownerId: "spoof" }],
        })
      ).status,
      400,
    );
  } finally {
    await client.close();
    await run.close();
  }
});
test("large Unicode and JSON-escaped observations drain in byte-bounded batches through HTTP", async () => {
  const run = await start();
  let accepted = 0;
  try {
    for (const [kind, text] of [
      "界".repeat(8000),
      "\u0000".repeat(8000),
    ].entries()) {
      const queue = new DeliveryQueue(source, 100, 3600000, () => now);
      queue.pause(false);
      for (let i = 0; i < 60; i++)
        assert(
          queue.capture(
            event({
              eventId: `encoded-${kind}-${i}`,
              messageId: `encoded-${kind}-${i}`,
              text,
            }),
          ),
        );
      for (let batch = 0; batch < 8 && queue.status().queueDepth; batch++)
        await queue.flush(async (events, health) => {
          const body = { events, health };
          assert(
            new TextEncoder().encode(JSON.stringify(body)).byteLength <=
              MAX_INGEST_BYTES,
          );
          assert(events.length > 0 && events.length <= 100);
          const response = await request(
            run.url,
            "/v1/ingest",
            producerToken,
            body,
          );
          assert.equal(response.status, 200);
          accepted += (await response.json()).accepted;
        });
      assert.equal(queue.status().queueDepth, 0);
      assert.equal(queue.status().overflow, 0);
    }
    assert.equal(accepted, 120);
    let cursor: string | undefined;
    let read = 0;
    for (let page = 0; page < 3; page++) {
      const response = await request(
        run.url,
        "/v1/read_messages",
        readerToken,
        {
          limit: 100,
          ...(cursor ? { cursor } : {}),
        },
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      read += body.items.length;
      if (!body.hasMore) break;
      cursor = body.cursor;
    }
    assert.equal(read, 120);
  } finally {
    await run.close();
  }
});
test("error bodies and discovery never reveal rejected content, bearer, validation details or stack", async () => {
  const run = await start();
  try {
    const sensitive = "synthetic-sensitive-value";
    const error = await request(run.url, "/v1/ingest", producerToken, {
      events: [{ ...event(), conversationId: sensitive, extra: sensitive }],
    });
    const body = await error.text();
    assert.equal(error.status, 400);
    for (const value of [sensitive, producerToken, "stack", "ZodError"])
      assert(!body.includes(value));
    const bad = await request(run.url, "/v1/read_messages", sensitive);
    assert(!(await bad.text()).includes(sensitive));
    const origin = await fetch(new URL("/v1/read_messages", run.url), {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        Authorization: `Bearer ${readerToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(origin.status, 403);
  } finally {
    await run.close();
  }
});
test("approved browser origins get bounded preflights while HTTP and MCP still require authentication", async () => {
  const run = await start();
  const origin = "https://consumer.example.invalid";
  run.s.config.origins = [origin];
  const preflight = (route: string, overrides: Record<string, string> = {}) =>
    fetch(new URL(route, run.url), {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "Authorization, Content-Type, MCP-Protocol-Version",
        ...overrides,
      },
    });
  try {
    for (const route of ["/mcp", "/v1/read_messages", "/v1/ingest"]) {
      const response = await preflight(route);
      assert.equal(response.status, 204);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
      assert.equal(
        response.headers.get("Access-Control-Allow-Methods"),
        "POST",
      );
      assert.equal(
        response.headers.get("Access-Control-Allow-Credentials"),
        null,
      );
      const unauthenticated = await fetch(new URL(route, run.url), {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(unauthenticated.status, 401);
      assert.equal(
        unauthenticated.headers.get("Access-Control-Allow-Origin"),
        origin,
      );
    }
    const excluded = await preflight("/mcp", {
      Origin: "https://excluded.example.invalid",
    });
    assert.equal(excluded.status, 403);
    assert.equal(excluded.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal(
      (await preflight("/mcp", { "Access-Control-Request-Method": "DELETE" }))
        .status,
      403,
    );
    assert.equal(
      (
        await preflight("/mcp", {
          "Access-Control-Request-Headers": "X-Unsafe",
        })
      ).status,
      403,
    );
    assert.equal((await preflight("/unknown")).status, 403);
    assert.equal(
      (
        await preflight("/v1/producer-scope", {
          "Access-Control-Request-Method": "GET",
        })
      ).status,
      204,
    );
    const read = await fetch(new URL("/v1/read_messages", run.url), {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: `Bearer ${readerToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("Access-Control-Allow-Origin"), origin);
    const client = new Client({ name: "synthetic-browser", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL("/mcp", run.url), {
          requestInit: {
            headers: { Origin: origin, Authorization: `Bearer ${readerToken}` },
          },
        }),
      );
      assert.equal((await client.listTools()).tools.length, 5);
    } finally {
      await client.close();
    }
  } finally {
    await run.close();
  }
});
test("remote-shaped loopback proxy requests validate actual JWTs and TLS/host policy for HTTP and MCP", async () => {
  const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } =
    await import("jose");
  const { configSchema } = await import("../packages/service/src/config.js");
  const { authenticator } = await import("../packages/service/src/auth.js");
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "synthetic-http-key";
  const cfg = configSchema.parse({
    ...config(),
    remote: true,
    publicUrl: "https://bridge.example.invalid",
    auth: {
      mode: "jwt",
      issuer: "https://issuer.example.invalid",
      jwksUrl: "https://issuer.example.invalid/jwks",
      readerAudience: "https://bridge.example.invalid/mcp",
      producerAudience: "https://bridge.example.invalid/ingest",
      grants: [
        { subject: "synthetic-reader", role: "reader", sourceIds: [source.id] },
        {
          subject: "synthetic-producer",
          role: "producer",
          sourceIds: [source.id],
        },
      ],
    },
  });
  const s = new Store(cfg, () => now);
  const server = createApp(
    s,
    authenticator(cfg, createLocalJWKSet({ keys: [jwk] })),
  ).listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Simulate a trusted loopback proxy's TLS header. This is not a TLS deployment.
  cfg.publicUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = (role: string) =>
    new SignJWT({ scope: role === "reader" ? "bridge:read" : "bridge:ingest" })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid! })
      .setSubject(`synthetic-${role}`)
      .setIssuer("https://issuer.example.invalid")
      .setAudience(
        `https://bridge.example.invalid/${role === "reader" ? "mcp" : "ingest"}`,
      )
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(privateKey);
  const proxyHeaders = {
    "X-Forwarded-Proto": "https",
  };
  const read = await token("reader"),
    produce = await token("producer");
  const client = new Client({ name: "synthetic-jwt-client", version: "1" });
  try {
    const denied = await fetch(new URL("/v1/read_messages", url), {
      method: "POST",
      headers: {
        Host: "bridge.example.invalid",
        Authorization: `Bearer ${read}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(denied.status, 403);
    const ingest = await fetch(new URL("/v1/ingest", url), {
      method: "POST",
      headers: {
        ...proxyHeaders,
        Authorization: `Bearer ${produce}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ events: [event()] }),
    });
    assert.equal(ingest.status, 200, await ingest.text());
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", url), {
        requestInit: {
          headers: { ...proxyHeaders, Authorization: `Bearer ${read}` },
        },
      }),
    );
    const result = await client.callTool({
      name: "read_messages",
      arguments: {},
    });
    assert.equal(
      JSON.parse((result.content as { text: string }[])[0].text).items.length,
      1,
    );
    const metadata = await fetch(
      new URL("/.well-known/oauth-protected-resource/mcp", url),
      { headers: proxyHeaders },
    );
    assert.equal(
      (await metadata.json()).resource,
      "https://bridge.example.invalid/mcp",
    );
    const wrong = await fetch(new URL("/v1/read_messages", url), {
      method: "POST",
      headers: {
        ...proxyHeaders,
        Authorization: `Bearer ${produce}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(wrong.status, 401);
  } finally {
    await client.close();
    server.close();
    await once(server, "close");
    s.close();
  }
});
