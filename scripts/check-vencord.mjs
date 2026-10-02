import { access, cp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
// Explicit isolated upstream checkout only; never discovers or edits a live client.
const target = process.env.VENCORD_CHECKOUT;
if (!target)
  throw new Error(
    "Set VENCORD_CHECKOUT to a clean disposable upstream Vencord checkout",
  );
const root = resolve(target);
if (!root.startsWith("/tmp/") && !root.startsWith("/var/tmp/"))
  throw new Error("Disposable temporary checkout required");
await access(resolve(root, "src/utils/types.ts"));
const git = spawnSync("git", ["status", "--porcelain"], {
  cwd: root,
  encoding: "utf8",
});
if (git.status !== 0 || git.stdout.trim())
  throw new Error("Clean upstream checkout required");
await cp(
  "dist/vencord/discordContextBridge",
  resolve(root, "src/userplugins/discordContextBridge"),
  { recursive: true, errorOnExist: true, force: false },
);
for (const args of [["exec", "tsc", "--noEmit"], ["build"]]) {
  const run = spawnSync("pnpm", args, { cwd: root, stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
