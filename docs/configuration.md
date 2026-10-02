# Configuration

`BRIDGE_CONFIG` names a private JSON configuration outside the checkout. `npm run setup` creates `config.json` in the application state directory: the platform home directory's `.local/share/discord-context-bridge` by default, or `BRIDGE_STATE_DIR`. The initial credential helper targets Unix/Linux state and file permissions; other OS credential integrations are untested. Setup resolves filesystem aliases and rejects state inside a Git checkout before creating directories or credentials. Keep this directory owner-only and files mode 0600. Do not commit the resulting configuration, credentials or database.

## Service fields

| Field              | Meaning/default                                                       |
| ------------------ | --------------------------------------------------------------------- |
| `ownerId`          | Required configured single owner; never supplied by a request         |
| `database`         | Required persistent SQLite file path; `:memory:` is for tests         |
| `port`             | 8787; range 1024–65535; bind address remains loopback                 |
| `publicUrl`        | `http://127.0.0.1:8787`; HTTPS origin for remote use                  |
| `remote`           | `false`; remote mode requires HTTPS public URL and JWT authentication |
| `origins`          | Empty by default; exact approved browser Origin values                |
| `retentionDays`    | 7; range 1–30; cutoff based on message creation                       |
| `cursorTtlSeconds` | 900; range 60–3600                                                    |
| `sources`          | At most 100 selected sources                                          |
| `auth`             | Local credential hashes or external JWT issuer configuration          |

A source has `id`, `type` (`bot` or `personal`), `accountId`, `enabled` (default false), `generation` (default 1) and `conversations` (at most 100). Bot conversations require a `guildId`; personal conversations must omit it. IDs below are fabricated examples, not usable Discord resources:

```json
{
  "id": "server-reader",
  "type": "bot",
  "accountId": "100000000000000001",
  "enabled": false,
  "generation": 1,
  "conversations": [
    { "id": "100000000000000002", "guildId": "100000000000000003" }
  ]
}
```

A personal source can use `id: "personal-client"`, `type: "personal"`, an explicitly selected actual account ID, and conversation entries containing only `id`. Replace synthetic IDs only in private configuration after authorization.

Startup seeds sources only when absent. Persisted revocation survives restart and overrides startup configuration; editing JSON does not silently reauthorize it. An operator-approved `npm run control -- apply-scopes` imports configured scopes, purges existing content, advances generations and invalidates cursors. Use `npm run control -- status` to obtain current generations. Stop producers while applying scopes and configure the plugin's generation explicitly afterward. Narrowing/disabling startup configuration also revokes conflicting stored scopes conservatively.

Browser access requires an exact canonical HTTP/HTTPS origin in `origins`, such as `https://consumer.example.invalid` without a trailing slash, path, credentials, query or fragment. Noncanonical entries are rejected at setup/startup rather than silently failing to match. Approved origins receive CORS response headers and bounded unauthenticated OPTIONS preflights for the documented routes, methods and Authorization, Content-Type and MCP-Protocol-Version headers. Actual requests still require the correct bearer role; no cookies or credentialed CORS are enabled. Empty origins denies cross-origin browser access. A configured origin is a browser policy, not an authorization grant.

## Authentication

Local `auth` is `{ "mode": "local", "credentials": [...] }`. Setup generates random opaque credentials with a 30-day expiration, stores SHA-256 hashes in configuration and saves raw credentials privately. Each grant has `subject`, `role` (`reader` or `producer`), `sourceIds`, optional `conversationIds`, `tokenHash` and `expiresAt` (Unix seconds). Setup-generated credentials expire after 30 days; expired local credentials are rejected. Omitted conversation restriction means all selected conversations in the granted sources. Do not widen generated grants without reviewing them. Local authentication has no OAuth discovery or authorization server.

Remote `auth` is:

```json
{
  "mode": "jwt",
  "issuer": "https://identity.example.invalid/",
  "jwksUrl": "https://identity.example.invalid/.well-known/jwks.json",
  "readerAudience": "https://bridge.example.invalid/mcp",
  "producerAudience": "https://bridge.example.invalid/ingest",
  "grants": [
    {
      "subject": "approved-consumer",
      "role": "reader",
      "sourceIds": ["server-reader"]
    },
    {
      "subject": "approved-producer",
      "role": "producer",
      "sourceIds": ["server-reader"]
    }
  ]
}
```

Use an actual external authorization server, distinct audiences and subjects appropriate to its issued tokens. Authentication URLs must use HTTPS without credentials, query strings or fragments; issuer metadata must never contain secrets. JWTs require RS256 or ES256 signatures, matching issuer/audience, `sub`, `iat`, `exp`, maximum age one hour and `bridge:read` or `bridge:ingest` scope. Configured grants determine owner and source access. The connector verifies tokens with `jose` and does not issue remote tokens, register OAuth clients or implement an authorization-code flow. Confirm your consumer can obtain and present suitable bearer tokens.

## Reader and plugin settings

The bot uses `BRIDGE_URL` (default loopback port 8787), `BRIDGE_SOURCE_ID`, `BOT_HISTORY_LIMIT` (0–100, default 50) and `BOT_HISTORY_DAYS` (1–365, default 7). It reads `DISCORD_BOT_TOKEN` and `BRIDGE_PRODUCER_TOKEN` from the credential helper. `BOT_HISTORY_DAYS` does not override remote retention. URL credentials and unencrypted remote origins are rejected.

The plugin settings select endpoint, personal source ID, account ID, conversation IDs, current generation, queue limit (1–1000, default 500), expiry (1–60 minutes, default 60) and observation consent (false initially). Start/setting changes pause export; Resume requires a session-only producer credential entered into a password field. Never supply a Discord login token.

## Rotation and revocation

Use local control to revoke the affected source/conversation before replacing its producer credentials. For local auth, remove the old hash from private configuration and restart the connector; provision a new private credential/hash pair without printing it. For JWT auth, revoke the issuer grant/credential and remove or narrow the configured bridge grant, then restart. Short token lifetime limits exposure but is not instant issuer revocation checking.

Reset a bot token in Discord's Developer Portal and enter its replacement with `npm run setup`. OS keyring entries can be updated by setup; owner-only fallback files deliberately refuse implicit overwrite; explicit setup replacement/rotation validates private file ownership. Use the explicit setup rotation/replacement action after revocation; stop the connector first, then restart with the updated local hash. Preserve unrelated state. Never paste secrets into diagnostics or tickets.
