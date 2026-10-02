# Contributing

Use supported Node/npm, `npm ci`, then `npm run check`. The complete local gate runs type checking, ESLint/Prettier, synthetic tests, production build and publication/privacy checks. No real Discord account, bot token or network-dependent Discord test is required. Do not activate the plugin in an everyday client as a build check.

Prefer one small maintainable change. Shared schemas and authorization belong in the domain/service layers; source adapters must remain independent from consumers. Preserve read-only access, disabled defaults, exact allowlists, owner/account isolation, generation revocation, bounded queues/history and current-body deletion semantics. New behavior needs meaningful synthetic regressions and updated relevant documentation. Do not add dashboards, personas, scoring, provider SDKs or background notification agents without a demonstrated requirement.

Use securely created task-scoped temporary directories under an appropriate temporary filesystem for downloads and disposable fixtures, with cleanup of only owned files. Keep dependencies, generated assets and private runtime data out of Git. Never copy private repository code without publication rights and a compatible license. Preserve legal notices for third-party code.

Plugin compatibility checks require a clean disposable upstream Vencord checkout. `scripts/check-vencord.mjs` copies the built plugin there and runs upstream type/build checks. Read [plugin documentation](docs/plugin.md) for the exact workflow and recorded limitations. An upstream build is separate from live-client behavior.

Before a PR, inspect the complete diff, run `git diff --check` and the applicable local gate, and identify the tested revision/tool versions. Label unavailable checks accurately. CI configuration is supplemental; do not trigger hosted Actions merely to complete local validation. Never fabricate statuses. PRs must contain no live message text, credentials, private configuration or personal workstation paths. Use synthetic examples with `.invalid` domains.

MIT contributions are licensed under the project license. Report security issues using [SECURITY.md](SECURITY.md), rather than publishing exploit details or sensitive evidence in ordinary issues.
