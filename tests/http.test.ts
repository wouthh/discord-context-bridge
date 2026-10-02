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
