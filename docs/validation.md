# Validation boundaries

The initial implementation was validated with Node 22.23.3, npm 12.2.0,
TypeScript 5.9.3, MCP SDK 1.32.0, discord.js 14.27.0 and better-sqlite3 13.0.3.
The lockfile records exact dependencies and integrity hashes. Tests create only
synthetic content in memory or securely created temporary directories.

`npm run check` runs TypeScript, ESLint, formatting, synthetic tests, production
builds and publication pattern checks. The initial suite passed 70 tests covering
compatibility-helper and private-state symlink isolation, canonical browser origins, approved-origin CORS preflights,
capture/ingest/read scopes, owner/account isolation, role and JWT audience/expiry,
edits, duplicate/out-of-order delivery, deletions, recoverable unavailable edits,
retention, revocation persistence, concurrent SQLite control, stable insertion
sequences, cursor expiry/retention resync, queue pressure/backoff, synthetic secret
file permissions, setup alias-retarget protection, lost-revocation-response reconciliation, grant-filtered revocation barriers, validated plugin control retries, unconfirmed control recovery across restart and unrelated generation changes, native UTF-8 limits, Unicode/escaped-text ingestion batches, Unicode lowercase search with pagination/edit/deletion scope, stalled bot export deadline and pause recovery, persistent restart/checkpoint recovery and actual loopback HTTP/MCP SDK readers sharing one data layer. A simulated loopback TLS-proxy request exercises signed synthetic JWT ingestion and MCP reads; it is not an HTTPS deployment test.
`npm audit` reported zero advisories in the resolved dependencies.

Generated plugin source passed upstream Vencord TypeScript and native/renderer
production builds at the pinned revision and tools listed in [plugin.md](plugin.md).
An independent automated code reviewer examined authorization, concurrency,
cursors, source adapters, secret handling and documentation. Identified defects
were repaired and checked. PR validation receipts identify the exact tested commit
and tree; automated review does not substitute for human approval.

The manual CI workflow is economical and synthetic. No hosted Actions were
triggered or counted as passing. No real Discord credentials, conversations,
bot login, client activation, remote deployment, consumer installation or consumer
product read were used. Loopback synthetic HTTP/MCP and synthetic JWT verification
prove those local boundaries only; authenticated HTTPS deployment, issuer enrollment,
client/native IPC behavior and product compatibility still need authorized live
validation. See [setup.md](setup.md#authorized-live-validation-checklist).

The optional Sites hosting/installation workflow was inspected from available tool
contracts and skill guidance. No Site or plugin was created/deployed/installed; a
forwarding adapter is not shipped. No provider compatibility is claimed.
