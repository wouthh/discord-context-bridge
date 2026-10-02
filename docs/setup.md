# Local and remote setup

No live credentials, client activation, server installation or deployment are needed to build and test this project. Perform each live step only after deciding its source scope and recipients.

## Local development

1. Install supported Node/npm and run `npm ci --ignore-scripts`, `npm rebuild better-sqlite3`, then `npm run check`. Tests use synthetic fixtures and temporary/in-memory databases.
2. Run `npm run setup`; choose creation of disabled loopback configuration. It creates a private `config.json`, separate opaque reader/producer credentials with a 30-day expiration and their hashes. Renew local credentials manually using the setup rotation action before expiration; there is no automatic refresh. Existing configuration/fallback files are not overwritten during initial creation; explicit replacement/rotation is a separate interactive choice. `secret-tool` and an available session keyring are preferred; otherwise raw credentials are saved in owner-only `.secret` files outside the repository. Do not print those files.
3. Set `BRIDGE_CONFIG` to the private application-state `config.json`. The default state directory is described in [configuration](configuration.md); `BRIDGE_STATE_DIR` can name a different owner-only absolute directory outside the checkout. Never source an example file as a finished configuration.
4. Run `npm run build` and `npm start`. The connector listens only on loopback port 8787. No sources are selected yet. Configure private source IDs/account IDs/conversations and grants; keep sources disabled while reviewing them.
5. Explicitly enable approved sources, stop producers, run `npm run control -- apply-scopes`, and run `npm run control -- status` to inspect current generations. This import purges existing content and invalidates cursors. Restart the service when its authentication/other configuration changes.

Do not store database/configuration under version control. Back up private state only according to a separately chosen encrypted backup/retention policy.

## Server source

Follow [bot installation](bot.md) and disclose collection to channel members. Use a dedicated bot, exact guild/channel pairs and minimum permissions. Never supply a personal Discord login token.

Enter the bot token yourself in a local terminal:

```sh
npm run setup
```

Choose “Enter DISCORD_BOT_TOKEN manually”. The prompt masks input and sends the credential to the OS keyring or a new owner-only fallback file. It never prints the value. Set `BRIDGE_SOURCE_ID` to the configured bot source and `BRIDGE_URL` to the connector origin, then run `npm run bot` after building. Start the reader in a long-lived process, independently of the service. For a remote connector choose setup's issuer-provided producer credential option; a local opaque token is not accepted by remote JWT mode.

## Personal source

The shipped plugin is independent of other plugins. It observes only delivered DM/group-DM events and has no personal Discord REST client. Building it does not install or activate it.

Follow [plugin documentation](plugin.md) for an isolated upstream compatibility build and later manual installation. Installing into an everyday client is a separate explicit choice. Start disabled. Configure the exact authorized account, selected conversation IDs, personal source ID, HTTPS/loopback endpoint and current generation. Review what destination receives exported content. Enable observation, then use the password input to enter the **bridge producer credential**, not a Discord login token, and Resume. Use the OS credential manager UI to copy the bridge credential privately into this field; for a fallback file, use a private local editor, never a terminal print command or chat. This credential is session-only and cleared by pause/settings changes/logout. Confirm an excluded conversation remains excluded.

## Pause, disconnect, purge and revoke

Plugin Pause/disconnect clears its queue and session credential. Stopping the bot clears its memory queue. These actions stop new export but do not purge already exported data.

Owner commands, with `BRIDGE_CONFIG` set:

```sh
npm run control -- status
npm run control -- purge personal-client
npm run control -- revoke personal-client selected_conversation_id
npm run control -- revoke server-reader
```

Use your private configured identifiers. Purge removes bodies while preserving scope; revoke removes a conversation or disables the source. Both advance source generation and invalidate cursors. Revocation is persisted across restart. The plugin also provides remote purge/revoke controls; require an accepted response before treating remote purge as confirmed. Re-read generation before resuming an approved remaining scope.

Revoke remotely **before** removing a plugin conversation setting. If offline, pause locally and use the connector owner's control command or remove the producer grant; do not assume local deselection purges the remote store. Local queue aborts cannot retract a completed upload. Server-side generation changes reject later stale submissions; already accepted data needs a confirmed server purge. Consumer copies and independent backups require their own deletion procedures.

## Remote operation

This is deployment-ready code, not a deployed public service. No live remote transport, consumer installation or product read is claimed.

A concrete generic path is a private persistent host for Node/SQLite, a TLS reverse proxy on that host, an external OAuth/OIDC issuer providing JWT access tokens, and an authorized MCP/HTTP client that can present those tokens:

1. Choose the host, domain, TLS and external issuer separately; provision nothing until authorized. Keep the connector process on loopback and persistent storage private. Run the Discord bot gateway in a long-lived process, locally or on an approved host.
2. Configure `remote: true`, HTTPS `publicUrl`, distinct reader and producer audiences, issuer/JWKS URLs and narrow per-subject grants as documented in [configuration](configuration.md). Require short-lived RS256/ES256 access tokens with matching scopes. Confirm the issuer actually produces the documented claims. The connector does not host OAuth login/client registration.
3. Configure the TLS reverse proxy to forward only to `127.0.0.1:8787`, preserve the exact configured public Host, and set `X-Forwarded-Proto: https` itself. Strip untrusted forwarded headers. Keep HTTP/private backend unreachable externally. The bridge trusts only a loopback proxy; test that direct HTTP, an incorrect Host, an unapproved Origin and unauthenticated requests are rejected. Disable proxy request-body and Authorization logging; use metadata-only access logs or none.
4. Enroll producers and readers independently at the issuer. Save a producer token through setup or the deployment secret store; grant only its assigned source. An expired token stops export until refreshed manually; automatic token renewal is not included. Configure the optional plugin with its separate source credential.
5. Give an approved consumer `https://bridge.example.invalid/mcp` and its reader token via that consumer's supported private credential mechanism, or HTTP `/v1/*`. Replace the example domain. If the consumer requires an OAuth enrollment flow, verify its issuer/client support before installation; protected-resource metadata alone is insufficient.
6. First validate synthetic ingestion with a producer credential, then a reader `connection_status` and scoped read over HTTPS. Validate anonymous/wrong-role rejection. Only then perform an authorized live read and record which consumer/runtime actually succeeded.

Generic MCP SDK and HTTP examples are provided in `examples/`. ChatGPT dots, Grok-powered applications and Hermes have not been installed or tested. Transport support, authentication, data retention and scheduling differ by consumer. Polling `read_changes` and health is a consumer capability; it does not automatically notify or wake an assistant.

### Optional Sites path: not shipped

The available Sites workflow was inspected: create a Site, enable its MCP capability, save/deploy privately, request Site metadata including MCP connection information, and suggest the returned installable plugin ID to the consumer. This identifies a possible future installation route; it does not deploy this connector or verify a consumer read.

The core long-lived Node gateway/SQLite process cannot be assumed to run in a request-only Site runtime. A future reviewed adapter would need a separate HTTPS connector, trusted Sites user identity bound to the configured owner, a separate backend reader credential and independently authenticated producers. It must forward only scoped read operations and keep credentials private. Such an adapter is not included. Deployment, persistent access, installation and live reads require explicit authorization and suitable tools; do not weaken authentication to make the path work.

## Authorized live-validation checklist

Use newly written benign test messages only. Record each result and any gaps without recording conversation bodies or tokens.

- Confirm exact selected bot server/channel and personal account/DM, plus an excluded server channel and excluded DM. Verify both excluded conversations are absent from capture, ingestion and reads.
- Confirm minimum bot permissions and Message Content access with known test text; confirm no Administrator permission. Start the plugin disabled; Resume only after reviewing its selected account/conversation.
- Create one selected message in each source. Verify authenticated producer receipt and reader HTTP/MCP read, including IDs, timestamps, source links and coverage warnings.
- Edit each selected message. Verify current bodies replace prior bodies, including a delayed/duplicate create test where feasible. Delete each while sources are connected; verify content-free tombstones and no old body in current reads/changes.
- Disconnect/reconnect each source. Verify health gaps and bounded recovery; explicitly note that offline deletions cannot be proven complete. Test queue pressure using controlled benign fixtures rather than flooding a real community.
- Revoke/deselect each selected conversation while it has queued test data. Confirm local queue clearing, remote acknowledgement, generation increase, purge and stale producer rejection. Recheck the excluded conversations. Restart the service and confirm revocation persists.
- Perform a real authorized read by the intended consumer using reader authentication. Record separately: deployed authenticated transport, successful consumer installation, and actual scoped read. Verify unauthenticated, wrong-owner/account, wrong-role and out-of-scope requests fail.
- Verify pause/disconnect and token rotation/revocation. Check logs and proxy diagnostics for content/credential leakage. Document issuer token lifetime, remote retention, backup retention and consumer cache deletion limits.
