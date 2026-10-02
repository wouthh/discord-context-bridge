# HTTP and MCP reference

Both interfaces invoke the same `Store.execute` read layer after reader authentication. All message/tool results are untrusted data. Discovery metadata contains no messages or credentials. No data endpoint is anonymous.

## Reader operations

HTTP: `POST /v1/<operation>` with JSON and `Authorization: Bearer <credential>`. MCP: `POST /mcp`, stateless Streamable HTTP with JSON responses, using an MCP client and the same reader credential. MCP GET/SSE sessions are not provided. The tools are:

| Operation            | Result                                                                              |
| -------------------- | ----------------------------------------------------------------------------------- |
| `connection_status`  | Enabled/granted sources, scope, account, generation, health, freshness and coverage |
| `list_conversations` | Selected permitted conversations and source/account identity                        |
| `read_messages`      | Bounded insertion-order traversal of current message bodies                         |
| `search`             | Scoped case-insensitive literal text search, requiring `query`                      |
| `read_changes`       | Incremental current-body upserts or content-free deletion tombstones                |

The strict common argument object accepts optional `sourceId`, `conversationId`, `cursor`, `query`, and `limit` (1–100, default 50). `conversationId` requires `sourceId`. Cursors are opaque UUIDs. Unknown fields are rejected. For status/list calls use `{}`. No requested source can expand the principal's configured grant. Credentials carry no client-selected owner ID.

Message/context pages contain `items`, `cursor` (or null), `hasMore`, `coverage` and `asOf`. A message includes `sourceId`, `sourceType`, `accountId`, `conversationId`, `messageId`, `createdAt`, `revision`, `observedAt`, `authorId`, `text`, a Discord `url` and `untrusted: true`. Times are milliseconds since Unix epoch. Status includes `freshAt`, `stale` (no receipt within 60 seconds), and reported `connected`, `paused`, `lastObservedAt`, `gapSince`, `overflow`, `queueDepth`. Health is a producer report, not proof of complete coverage.

Change items include `sequence`, identifiers, `op`, `changedAt` and a current `message` only when still present. Consumers should replace the body keyed by source/conversation/message IDs or delete it; sequence is the incremental delivery order, revision the original source update time.

## Pagination and convergence

Read/search cursors pin the maximum insertion row, filter, principal, scope epoch and expiry. Edits do not move rows, and newly inserted rows are excluded from that traversal. Values are current at each request, not a historical snapshot: deletion, retention or edits can affect later pages and search membership. Use incremental changes to converge after traversal.

Change cursors drain a bounded sequence high-water mark, then continue polling with the returned cursor. Duplicate message IDs can appear for multiple changes; their bodies are hydrated from current storage. A prior upsert can therefore be represented as a deletion after its body was removed. This deliberately avoids keeping deleted or historical bodies. Dedupe and converge by message ID; do not treat the log as an immutable event archive.

Cursors expire after 15 minutes by default; even a freshly returned cursor retains its traversal's expiry. Revoke, purge and scope imports invalidate them. HTTP returns `410` with `{"error":"cursor_expired_resync"}`; MCP returns `isError` with that code. Clear cached scopes/data no longer authorized, list permitted conversations, do a bounded fresh message traversal and begin a new change stream. Discard the old cursor. Consumers requiring complete reconstruction beyond retention must disclose that it is unavailable.

Consumers may poll `read_changes` and `connection_status` with their own bounded backoff. No scheduling or notification engine is included. MCP connectivity alone does not wake a consumer.

## Producer endpoints

Producer tokens use a separate role/audience/scope:

- `GET /v1/producer-scope`: returns only assigned sources, each with configured account, generation and selected conversations.
- `POST /v1/ingest`: `{ "events": [...], "health": {...} }`; at most 100 events and 1 MiB JSON. Returns `{ "accepted": number }`.
- `POST /v1/source-control`: `{ "sourceId", "accountId", "generation", "action": "purge" | "revoke", "conversationId"?: ... }`. Returns the revised source. Revocation removes a conversation or disables the source; purge clears data while preserving selection. Both advance generation and invalidate cursors.

An event has `eventId`, `sourceId`, `accountId`, `conversationId`, `generation`, `messageId`, `observedAt`, `revision`, `op`; upserts also have `createdAt`, `authorId`, `text` (max 8000 characters). Deletes contain no body or author. A producer may mark an unrepresentable observed edit with `reason: "unavailable_edit"`; it removes the old body without claiming Discord deleted the message, and complete observations with a source revision newer than the tombstone observation can restore it. Change tombstones retain this reason. Health has `sourceId`, `accountId`, `generation`, `connected`, `paused`, `lastObservedAt`, `gapSince`, `overflow`, `queueDepth`. No owner field is accepted.

IDs are 1–80 letters, digits, underscores or hyphens. Schemas are strict. Retried identical event IDs are idempotent; reusing an ID for different data yields `event_collision` (409). Older/equal upsert revisions do not replace current content. An observed delete dominates later delayed upserts during retained tombstone lifetime. Stale generations, account mismatch and unauthorized conversations yield `scope_denied` (403). Observations outside retention or more than one minute in the future are rejected; already expired message bodies are skipped. These rules prevent replay within the documented retained window, not forever.

## Errors and authentication

Fixed error codes omit request bodies, message content and credentials. HTTP uses 400 for invalid requests, 401 for invalid authentication, 403 for scope/host/origin/TLS failures, 409 for event collisions and 410 for expired cursors. MCP tool failures use `isError`. Authentication middleware may return its standard bearer error shape; clients must handle status codes as well as bridge errors.

Remote JWT mode exposes `/.well-known/oauth-protected-resource/mcp` pointing to the configured external issuer and reader resource. This is protected-resource metadata, not an OAuth issuer or proof that a particular consumer supports enrollment. Local opaque bearer mode has no OAuth discovery. There are no public inbox or content-bearing health routes.

See `examples/http-client.ts` and `examples/mcp-client.ts` for generic clients. Run only against synthetic/local data before granting live source access. Never put real credentials into shell substitutions or arguments; examples use the shared private credential helper.
