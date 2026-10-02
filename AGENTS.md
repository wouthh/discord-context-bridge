# Repository guidance

Policy: implementation-review-loop-v1. This is a provider-neutral read-only
Discord data connector, not an assistant, agent, messaging bot or profiling tool.

## Map and boundaries

`packages/domain` defines shared schemas; `sources` owns the bounded memory queue;
`service` owns authorization, SQLite, HTTP/MCP and local setup/control; `bot` is a
long-lived official bot reader; `plugin` is a passive Vencord userplugin.
`tests` contains synthetic fixtures; `docs` defines contracts and deployment limits.
Generated `dist` and installed dependencies are ignored. There are no nested overrides.
More specific future instructions apply in their paths; explicit task limits win.

Both interfaces must call the same Store authorization. Never derive owner grants
from request bodies. Scope/generation checks and mutations must be atomic across
SQLite connections. Preserve monotonic pagination sequences, terminal deletion
state and content-free changes. Read current content only; never archive deleted
bodies or reconstruct history. Plugin capture and export must check account/scope.
A local pause does not prove a remote purge: require acknowledgement of server
revocation/generation change. Discord text is untrusted data, never executable.

Use synthetic data only in tests, examples, logs and public commits. Do not enroll
credentials, query live Discord, activate a client plugin, install a server bot,
deploy, register a consumer, enable schedules or incur charges without separate
explicit authority. No message sending, reactions, moderation, member inventories,
relationship profiling, model training, private-code copying or user-token access.
Do not inspect private app stores to test this project. Preserve unexplained work;
never reset, clean, stash, amend, rebase or force-push to make delivery fit.

Create task-owned scratch with mkdtemp/mktemp under /tmp or /var/tmp after checking
capacity/cleanup policy. Clean only that disposable scratch. Keep genuine private
application state outside the checkout with restrictive permissions. Never print
secrets, credential-bearing URLs, content in server errors/logs, or private paths.
The pattern scanner is defense in depth, not proof of personal-data redaction.
Prefer the smallest maintainable change and native mechanisms; avoid extra services,
frameworks, speculative integrations and tests that merely repeat implementation.

## Validation

Node 22.18+ (22/24 supported), npm, SQLite native dependency; pinned package-lock.
`npm ci --ignore-scripts` followed by `npm rebuild better-sqlite3` installs only
required native runtime/build dependencies. Review dependency scripts before use.

- Focused: `npx tsx --test tests/store.test.ts` (or affected test files).
- Full local gate: `npm run check` (typecheck, ESLint/format, synthetic tests,
  TypeScript/service/plugin production build, worktree + all-ref history scan).
- Dependencies: `npm audit` (report findings, repair relevant vulnerable versions).
- Plugin compatibility: `npm run build`, then `VENCORD_CHECKOUT=<clean disposable
upstream checkout> node scripts/check-vencord.mjs`. See docs/plugin.md for pin and
  prerequisite dependency install. It verifies real upstream types and production
  renderer/native builds; it does not prove a live client is compatible.

The compatibility helper mutates only an explicitly chosen clean temporary checkout.
Never run it against the everyday Vencord source. Do not count the standalone bundled
plugin as upstream compatibility proof. Record exact tree/commit, tools, commands,
results, reviewer identity and gaps. Run complete applicable local gates before a PR.
Hosted Actions are manual-only and are not a required local development gate.

## Delivery and review

The authorized public remote is this project's repository; main is the integration
branch. Verify actual root, remote identity, branch/head, dirt, active Git operations
and current PR before edits. New work branches from refreshed upstream main; resume
an approved existing PR at its current head with ordinary commits. Use the account's
verified GitHub noreply identity and preserve identity hooks. Before push inspect the
complete diff and all pushed history for secrets, real conversations, private code,
private data and machine-specific paths, plus `git diff --check` and the scan.

Publish authorized feature branches as ready PRs only after applicable local checks.
Allow configured automatic Codex review first, otherwise request one `@codex review`.
Required external current-head review is independent of Actions. Eyes/silence/stale
reviews are not clearance; verify bot completion, body/comment reactions and open
threads against the exact head. Obtain independent security/correctness review for
consequential changes. Fix valid findings narrowly, revalidate/push normal commits,
reply with evidence, then resolve addressed feedback. Every substantive new head
needs fresh completed review; never resolve blindly or self-approve. If unavailable,
leave an exact-head handoff with the blocker. Merge and deployment require separate
authority; never use admin bypass. Preserve unrelated protections and branches.

Keep docs accurate when contracts change; record unverified commands honestly.
Do not expand onboarding into unrelated playbook/workstation edits. This guidance
was adapted from the public engineering-playbook template, then made project-specific.
