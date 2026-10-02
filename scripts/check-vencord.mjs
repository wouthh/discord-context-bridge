import { access, cp, lstat, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Validate actual paths before copying into an explicitly selected disposable checkout. */
export async function safeCheckout(target) {
  const root = await realpath(resolve(target));
  if (!root.startsWith("/tmp/") && !root.startsWith("/var/tmp/"))
    throw new Error("Disposable temporary checkout required");
  // Existing destination ancestors must be ordinary directories. Reject links
  // even when their targets happen to be inside temporary storage.
  for (const relative of ["src", "src/userplugins"]) {
    const path = resolve(root, relative);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (error.code === "ENOENT" && relative === "src/userplugins") continue;
      throw error;
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (await realpath(path)) !== path
    )
      throw new Error("Unsafe checkout destination ancestor");
  }
  const destination = resolve(root, "src/userplugins/discordContextBridge");
  try {
    await lstat(destination);
  } catch (error) {
    if (error.code === "ENOENT") return { root, destination };
    throw error;
  }
  throw new Error("Plugin destination already exists");
}

async function main() {
  const target = process.env.VENCORD_CHECKOUT;
  if (!target)
    throw new Error(
      "Set VENCORD_CHECKOUT to a clean disposable upstream Vencord checkout",
    );
  const { root, destination } = await safeCheckout(target);
  await access(resolve(root, "src/utils/types.ts"));
  const git = spawnSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  });
  if (git.status !== 0 || git.stdout.trim())
    throw new Error("Clean upstream checkout required");
  // Revalidate after metadata inspection, immediately before the only write.
  await safeCheckout(root);
  await cp("dist/vencord/discordContextBridge", destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  for (const args of [["exec", "tsc", "--noEmit"], ["build"]]) {
    const run = spawnSync("pnpm", args, { cwd: root, stdio: "inherit" });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
