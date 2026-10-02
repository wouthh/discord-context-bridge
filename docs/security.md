# Security, privacy and threat boundaries

This is a single-owner context service. Public code does not make stored data public. Operators control a private connector and explicitly authorize sources and consumers. No product integration is considered compatible merely because its name appears in examples.

## Data flow and minimization

The bot selects exact guild/channel pairs. The personal plugin selects an explicit logged-in account and DM/group-DM IDs before capture. Both filter before export, then the service independently checks the configured producer grant, account, generation and conversation. Readers receive only selected conversations permitted by their configured grant; a client-supplied owner ID is never trusted.

Export includes message text, minimal author ID, source/account/conversation/message IDs and creation/update/observation times. Links are derived from those IDs. Attachment bodies, profiles, relationship inventories and unrelated plugin journals are excluded. Messages can still contain personal/sensitive material; filtering known token-shaped strings does not redact arbitrary personal data or every credential. Tell participants exactly which selected content reaches which privately operated endpoint and which authorized applications can read it.

No attachment fetching, personal Discord login tokens, automated user-account API requests, hidden-conversation access or automated history scrolling are provided. The plugin is unofficial client modification, and passive observation is not asserted to be Discord-approved. Client modifications may violate applicable platform terms and expose accounts to enforcement; do not evade enforcement. See [Discord's terms](https://discord.com/terms), [bot documentation](bot.md) and the [Developer Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy). API-data relationship profiling and message-content model training are restricted. Operators and consumers must assess each downstream use; authorized data access does not grant blanket permission to train models or profile people.

## Trust boundaries

Discord content is untrusted data, including text that impersonates system instructions. Never execute it, treat it as authorization, or allow it to widen scope. The connector supplies data and read-only tool annotations; it cannot enforce a downstream model's reasoning or prevent an authorized reader from copying data.

Separate producer and reader credentials prevent an assistant from ingesting, purging or changing source scope. Remote JWT verification uses a supported library, fixed signature algorithms, issuer/audience checks, required claims, age limit and scopes; local development uses random opaque bearer credentials with configured expiration (setup defaults to 30 days). Renew or rotate them through local owner setup; there is no automatic refresh. Configured grants bind subjects to the single configured owner. The deployment operator, host administrator, issuer and an authorized compromised producer/reader remain trusted/high-impact boundaries. A malicious authorized producer can falsify content/health within its grant; this is not cryptographic proof of Discord provenance.

Loopback binding is always retained. Remote mode requires JWT/HTTPS configuration and a properly configured loopback TLS proxy. Host and Origin checks reduce DNS-rebinding/browser risks. They are not a firewall, encryption-at-rest layer or rate-limiting service. Public deployment should add ordinary proxy connection/request limits proportionate to exposure. Do not allow arbitrary internal backend access or untrusted proxy headers.

## Retention and deletion

Remote retention defaults to seven days based on original message creation, configurable 1–30 days. Expired bodies become content-free deletion changes. Current bodies are replaced on edit; no historical-body archive is exposed. Observed deletion removes text/author and dominates delayed upserts while the tombstone is retained. Content-free tombstones, change rows and dedupe records also expire within the retention policy. The minute sweep and read/ingest sweeps enforce retention while the service runs; a stopped host cannot perform deletion until restarted.

Queues are memory-only: default 500 events, one-hour expiry, batches of at most 100, bounded exponential retry delay. Plugin limits are configurable. Restart, pause, scope change, account mismatch and revocation clear queued bodies. Overflow/expiry discards queued entries and marks coverage loss. No promise is made that all delivered edits/deletions survive disconnection or overflow.

Purge/revoke advances generation, invalidates cursors and clears applicable stored bodies. Persisted revocation survives restart. A local pause cannot retract a completed request; remote acknowledgement is required before calling purge complete. Removing a local setting alone does not prove remote deletion: use remote controls or the owner command first. Offline deletions may never be observed. Consumers must clear cached scopes/data on cursor resync or revocation and implement their own retention/deletion policy.

SQLite secure deletion is enabled and graceful shutdown checkpoints/truncates WAL. This is not forensic secure erasure: filesystem snapshots, WAL behavior during operation, disk/controller storage, crash copies and independent backups can retain prior bytes. Protect the host and use encryption appropriate to the deployment. Choose backup retention explicitly; restoration must preserve revocation and avoid reintroducing expired content. Purging the live database cannot delete separately retained backups or consumer copies.

## Secrets and diagnostics

Enter live bot/bridge credentials only through local hidden-input setup or an approved deployment secret store. OS keyring storage is preferred; fallback files are outside the checkout, owner-only and refuse implicit overwrite; explicit setup replacement/rotation validates private file ownership. Never request a personal Discord token. Never echo credentials, put them in command arguments/URLs, attach private configuration or print keyring output. Bot startup/transport errors use fixed diagnostic codes; message content is absent from health and MCP discovery. Disable body/header logging in reverse proxies and observability agents too.

Public publication checks inspect tracked files/history for secret patterns, private data and machine paths; automated patterns are defense in depth. Manually review fixtures/docs/history. Tests must remain synthetic. Report vulnerabilities privately under [SECURITY.md](../SECURITY.md), with no real messages or credentials.

## Limits and response

No live deployment or actual assistant read has been verified. Automatic issuer credential renewal and real-time token revocation introspection are not shipped. A valid JWT can remain accepted until expiry unless the configured grant is removed and service restarted. Disable/revoke affected bridge grants, stop producers, purge scoped data, rotate issuer/bot credentials, and then inspect sanitized metadata. Do not broaden scope or weaken authorization to restore connectivity.

See [setup controls and live checklist](setup.md) for practical pause, revocation and validation steps. Scheduling, notifications, autonomous posting and any future event delivery are separate capabilities requiring separate authorization; none is included here.
