# discord-context-bridge

A read-only, single-owner Discord context service. A dedicated official Discord bot reads selected server text channels, and the service stores current message content in SQLite with retention and content-free deletion tombstones. Authorized applications read that context through authenticated HTTP and remote MCP, which share one authorization and data layer.

The code is open source; conversation data belongs in a private deployment. This project is unofficial and is not affiliated with Discord or any assistant provider. It provides data access. Reasoning, schedules, suggestions and notifications belong to consumers. It never sends Discord messages, reactions or moderation requests.

## Architecture

```text
Selected server channels -> official bot reader -> authenticated ingestion -> SQLite
                                                                               |
                                                                      scoped read layer
                                                                        /           \
                                                                HTTP /v1/*       MCP /mcp
```

`packages/domain` contains schemas, `packages/sources` the bounded delivery queue, `packages/bot` the official bot source and `packages/service` the connector. The initial deployment is one owner, one persistent SQLite database and ordinary long-lived Node processes. There is no dashboard or embedded AI agent. An [optional local source](#optional-local-source) can export into the same ingestion path.

## Coverage and privacy

Sources start disabled and require explicit selection. Exported fields are message text, minimal author ID, source/conversation/message IDs and timestamps. Attachment bodies, profiles and relationship inventories are excluded.

- Current edits replace bodies; observed deletions remove bodies and leave content-free tombstones.
- Remote retention defaults to seven days from message creation.
- Local queues are memory-only, bounded and expire after one hour by default.

Coverage is partial. Bot history is bounded to at most 100 recent messages per selected channel. Offline deletions, partial events and queue loss may be unknown. Secret-pattern filtering is a narrow defense in depth, not personal-data redaction. Read [security and privacy](docs/security.md) before enabling export, and see [bot documentation](docs/bot.md) for Discord permissions and platform restrictions.

## Local quick start

Requires Node 22.18 or later in the supported 22 to 24 range and npm. Native SQLite installation may require normal build tools on platforms without a compatible prebuilt binary.

```sh
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm run check
npm run setup
```

Choose "Create disabled loopback configuration" in setup. It generates separate reader/producer credentials without printing them, with no selected sources. Set `BRIDGE_CONFIG` to the configuration file created in the application state directory, then:

```sh
npm run build
npm start
```

The service binds to `127.0.0.1:8787`. All data endpoints require authentication. Follow [setup](docs/setup.md) to define scopes, enter a bot token using hidden input and enable a source. Do not put secrets in `.env`, shell arguments, URLs, source files or agent chat.

## Interfaces and consumers

The five read operations are `connection_status`, `list_conversations`, `read_messages`, `search` and `read_changes`. They are HTTP POST endpoints under `/v1/` and identically named MCP tools at `/mcp`, using Streamable HTTP. Incremental polling is consumer-controlled; MCP does not wake an assistant automatically. See [API reference](docs/api.md), [configuration](docs/configuration.md) and [remote setup](docs/setup.md#remote-operation).

Generic HTTP and MCP SDK examples use synthetic data. Local synthetic transport testing does not prove deployment, consumer installation or a real authorized read. ChatGPT dots, Grok-powered applications, Hermes and other products are untested; a runtime must support the configured transport and authentication. The optional Sites deployment discussion is a future adapter path, not a shipped dependency.

## Optional local source

`packages/plugin` contains an optional Vencord/Vesktop userplugin that observes selected DM/group DM events delivered to the running client and exports them into the same ingestion path.

**This is a client modification. Vencord and Vesktop are unofficial, client modifications are against Discord's Terms of Service, and using one may expose the account to enforcement.** Passive collection is not Discord-approved. Do not evade restrictions, and obtain participant consent as appropriate.

It is disabled by default. The plugin is not installed by setup; it is a separate manual install. Once installed, observation is off, no conversations are selected and no credential is loaded until the owner configures a scope and resumes. The matching connector source is also disabled by default.

The plugin never fetches personal-account history, scrolls, reads hidden conversations or requests personal Discord tokens. Read [plugin documentation](docs/plugin.md) before considering it.

## Validation and status

Shipped: scoped capture, ingestion, read operations, persistent current-message storage, tombstones, retention, bounded queues, opaque cursors, separate producer/reader authentication, bot process, plugin source and build tooling. Synthetic tests exercise authorization, updates, deletion, retention, scope changes, queues and HTTP/MCP behavior. Run `npm run check` for the local gate. Plugin upstream compatibility validation uses an isolated Vencord checkout; see [plugin documentation](docs/plugin.md) for evidence and remaining live-client gaps.

Not live-verified: Discord bot login/server installation, personal client activation, authenticated public deployment, installation in any assistant product or reads by that product. No deployment, credentials or live message upload are required for tests.

Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Vulnerability reporting: [SECURITY.md](SECURITY.md). License: [MIT](LICENSE); preserve third-party notices.
