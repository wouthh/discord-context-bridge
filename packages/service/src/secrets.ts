import { spawn } from "node:child_process";
import { mkdir, lstat, realpath, open } from "node:fs/promises";
import { homedir } from "node:os";
import { constants } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
export const stateDir = () =>
  process.env.BRIDGE_STATE_DIR ??
  join(homedir(), ".local", "share", "discord-context-bridge");
async function canonicalStatePath(path: string) {
  let ancestor = path;
  const missing: string[] = [];
  while (true) {
    try {
      return join(await realpath(ancestor), ...missing);
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}
async function assertOutsideRepository(path: string) {
  let parent = path;
  while (true) {
    try {
      await lstat(join(parent, ".git"));
      throw new Error("state_inside_repository");
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    const next = dirname(parent);
    if (next === parent) return;
    parent = next;
  }
}
export async function privateStateDir() {
  // Resolve aliases through the nearest existing ancestor before creating any
  // components, then use that canonical path for state and credential files.
  const path = await canonicalStatePath(resolve(stateDir()));
  await assertOutsideRepository(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const meta = await lstat(path);
  if (
    !meta.isDirectory() ||
    meta.uid !== process.getuid?.() ||
    (meta.mode & 0o077) !== 0
  )
    throw new Error("state_permissions_invalid");
  await assertOutsideRepository(await realpath(path));
  return path;
}
/** Open a canonical, private existing configuration; retain this handle during rotation. */
export async function openPrivateConfiguration(path: string) {
  const requested = resolve(path);
  if (!(await lstat(requested)).isFile())
    throw new Error("configuration_permissions_invalid");
  const parent = await canonicalStatePath(dirname(requested));
  await assertOutsideRepository(parent);
  const directory = await lstat(parent);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  )
    throw new Error("configuration_permissions_invalid");
  const file = await open(
    join(parent, basename(requested)),
    constants.O_RDWR | constants.O_NOFOLLOW,
  );
  try {
    const meta = await file.stat();
    if (
      !meta.isFile() ||
      meta.uid !== process.getuid?.() ||
      (meta.mode & 0o077) !== 0 ||
      meta.nlink !== 1
    )
      throw new Error("configuration_permissions_invalid");
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
const names = new Set([
  "DISCORD_BOT_TOKEN",
  "BRIDGE_PRODUCER_TOKEN",
  "BRIDGE_READER_TOKEN",
]);
async function keyring(
  action: "store" | "lookup",
  name: string,
  value?: string,
) {
  return new Promise<string>((resolve, reject) => {
    const args =
      action === "store"
        ? [
            "store",
            "--label=Discord context bridge credential",
            "application",
            "discord-context-bridge",
            "credential",
            name,
          ]
        : [
            "lookup",
            "application",
            "discord-context-bridge",
            "credential",
            name,
          ];
    const child = spawn("secret-tool", args, {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("keyring_unavailable"));
    }, 5000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("keyring_unavailable"));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(output.trim());
      else reject(new Error("keyring_unavailable"));
    });
    child.stdin.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("keyring_unavailable"));
    });
    child.stdin.end(value === undefined ? "" : value + "\n");
  });
}
export async function saveSecret(
  name: string,
  value: string,
  replace = false,
  io = keyring,
) {
  if (!names.has(name) || !value || /[\r\n]/.test(value))
    throw new Error("credential_invalid");
  try {
    await privateStateDir();
    await io("store", name, value);
    return "os-keyring";
  } catch {
    const path = join(await privateStateDir(), `${name}.secret`);
    const flags =
      constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const create = () =>
      open(path, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
    const file = replace
      ? await open(path, flags).catch((error: unknown) => {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return create();
          throw error;
        })
      : await create();
    try {
      const meta = await file.stat();
      if (
        !meta.isFile() ||
        meta.uid !== process.getuid?.() ||
        (meta.mode & 0o077) !== 0 ||
        meta.nlink !== 1
      )
        throw new Error("credential_permissions_invalid");
      // Opening without O_TRUNC preserves rejected files. Keep the validated
      // single-link inode pinned; this fresh handle's write position is zero.
      await file.writeFile(value, "utf8");
      await file.truncate(Buffer.byteLength(value, "utf8"));
      await file.sync();
    } finally {
      await file.close();
    }
    return "owner-only-file";
  }
}
export async function readSecret(name: string, io = keyring) {
  if (!names.has(name)) throw new Error("credential_invalid");
  try {
    const token = await io("lookup", name);
    if (token) return token;
  } catch {
    /* fallback */
  }
  try {
    const path = join(await privateStateDir(), `${name}.secret`);
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const meta = await file.stat();
      if (
        !meta.isFile() ||
        (meta.mode & 0o077) !== 0 ||
        meta.uid !== process.getuid?.() ||
        meta.nlink !== 1
      )
        throw new Error("credential_permissions_invalid");
      return (await file.readFile("utf8")).trim();
    } finally {
      await file.close();
    }
  } catch {
    throw new Error("credential_unavailable");
  }
}
