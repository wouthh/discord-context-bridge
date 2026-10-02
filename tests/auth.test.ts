import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { authenticator } from "../packages/service/src/auth.js";
import { configSchema } from "../packages/service/src/config.js";
import {
  config,
  readerToken,
  producerToken,
  reader,
  source,
} from "./fixtures.js";
test("opaque local credentials are role-bound with owner derived from configuration", async () => {
  const auth = authenticator(config());
  assert.equal((await auth(readerToken, "reader")).ownerId, reader.ownerId);
  await assert.rejects(auth(readerToken, "producer"));
  await assert.rejects(auth(producerToken, "reader"));
  await assert.rejects(auth("wrong", "reader"));
});
test("JWT issuer/audience/scope/expiry and trusted subject grant are required independently", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "synthetic-key";
  const c = configSchema.parse({
    ...config(),
    remote: true,
    publicUrl: "https://bridge.example",
    auth: {
      mode: "jwt",
      issuer: "https://issuer.example",
      jwksUrl: "https://issuer.example/jwks",
      readerAudience: "https://bridge.example/mcp",
      producerAudience: "https://bridge.example/ingest",
      grants: [
        {
          subject: "authorized-client",
          role: "reader",
          sourceIds: [source.id],
        },
      ],
    },
  });
  const auth = authenticator(c, createLocalJWKSet({ keys: [jwk] }));
  const token = (overrides: Record<string, unknown> = {}) =>
    new SignJWT({ scope: "bridge:read", ...overrides })
      .setProtectedHeader({ alg: "RS256", kid: "synthetic-key" })
      .setIssuer(c.auth.mode === "jwt" ? c.auth.issuer : "")
      .setAudience("https://bridge.example/mcp")
      .setSubject("authorized-client")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(privateKey);
  assert.equal((await auth(await token(), "reader")).ownerId, reader.ownerId);
  await assert.rejects(auth(await token(), "producer"));
  await assert.rejects(auth(await token({ scope: "bridge:ingest" }), "reader"));
  const outsider = await new SignJWT({ scope: "bridge:read" })
    .setProtectedHeader({ alg: "RS256", kid: "synthetic-key" })
    .setIssuer("https://issuer.example")
    .setAudience("https://bridge.example/mcp")
    .setSubject("unknown")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
  await assert.rejects(auth(outsider, "reader"));
  const expired = await new SignJWT({ scope: "bridge:read" })
    .setProtectedHeader({ alg: "RS256", kid: "synthetic-key" })
    .setIssuer("https://issuer.example")
    .setAudience("https://bridge.example/mcp")
    .setSubject("authorized-client")
    .setIssuedAt()
    .setExpirationTime(1)
    .sign(privateKey);
  await assert.rejects(auth(expired, "reader"));
});
test("remote configuration fails closed on insecure URLs, duplicate scopes and common audience", () => {
  const c = config();
  assert(!configSchema.safeParse({ ...c, remote: true }).success);
  assert(!configSchema.safeParse({ ...c, sources: [source, source] }).success);
  assert(
    !configSchema.safeParse({ ...c, publicUrl: "ftp://localhost" }).success,
  );
});
test("browser allowlists accept only canonical HTTP origins", () => {
  for (const origin of [
    "https://consumer.example.invalid",
    "https://consumer.example.invalid:8443",
    "http://127.0.0.1:8787",
  ]) {
    assert(configSchema.safeParse({ ...config(), origins: [origin] }).success);
  }
  const credentials = new URL("https://consumer.example.invalid");
  credentials.username = "synthetic";
  credentials.password = "synthetic";
  for (const origin of [
    "https://consumer.example.invalid/",
    "https://consumer.example.invalid/path",
    "https://consumer.example.invalid?query=synthetic",
    "https://consumer.example.invalid#fragment",
    "https://consumer.example.invalid:443",
    "ftp://consumer.example.invalid",
    credentials.href,
    "invalid",
  ]) {
    assert(!configSchema.safeParse({ ...config(), origins: [origin] }).success);
  }
});
test("local advertised ports match the listener while remote proxy ports may differ", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    for (const port of [8787, 9000]) {
      assert(
        configSchema.safeParse({
          ...config(),
          port,
          publicUrl: `http://${host}:${port}`,
        }).success,
      );
      assert(
        !configSchema.safeParse({
          ...config(),
          port,
          publicUrl: `http://${host}:${port + 1}`,
        }).success,
      );
    }
    for (const publicUrl of [`http://${host}`, `https://${host}`]) {
      assert(!configSchema.safeParse({ ...config(), publicUrl }).success);
    }
  }
  for (const publicUrl of [
    "https://bridge.example.invalid",
    "https://bridge.example.invalid:9443",
  ]) {
    assert(
      configSchema.safeParse({
        ...config(),
        port: 9000,
        publicUrl,
        remote: true,
        auth: {
          mode: "jwt",
          issuer: "https://issuer.example.invalid",
          jwksUrl: "https://issuer.example.invalid/jwks",
          readerAudience: "https://bridge.example.invalid/mcp",
          producerAudience: "https://bridge.example.invalid/ingest",
          grants: [],
        },
      }).success,
    );
  }
});
test("authentication metadata URLs cannot embed credentials or query secrets", () => {
  const baseline = {
    ...config(),
    remote: true,
    publicUrl: "https://bridge.example.invalid",
    auth: {
      mode: "jwt",
      issuer: "https://issuer.example.invalid",
      jwksUrl: "https://issuer.example.invalid/jwks",
      readerAudience: "https://bridge.example.invalid/mcp",
      producerAudience: "https://bridge.example.invalid/ingest",
      grants: [],
    },
  };
  for (const field of [
    "issuer",
    "jwksUrl",
    "readerAudience",
    "producerAudience",
  ]) {
    const credentialUrl = new URL("https://issuer.example.invalid/");
    credentialUrl.username = "synthetic";
    credentialUrl.password = "synthetic";
    assert(
      !configSchema.safeParse({
        ...baseline,
        auth: { ...baseline.auth, [field]: credentialUrl.href },
      }).success,
    );
    assert(
      !configSchema.safeParse({
        ...baseline,
        auth: {
          ...baseline.auth,
          [field]: "https://issuer.example.invalid/?secret=synthetic",
        },
      }).success,
    );
  }
});
