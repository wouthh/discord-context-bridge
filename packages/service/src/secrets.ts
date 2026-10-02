import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { constants } from "node:fs";
import { join, resolve, dirname } from "node:path";
export const stateDir = () =>
  process.env.BRIDGE_STATE_DIR ??
  join(homedir(), ".local", "share", "discord-context-bridge");
export async function privateStateDir() {
  const path = resolve(stateDir());
  let parent = path;
  while (true) {
    try {
      await lstat(join(parent, ".git"));
      throw new Error("state_inside_repository");
    } catch (error) {
      if (error instanceof Error && error.message === "state_inside_repository")
        throw error;
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const meta = await lstat(path);
  if (
    !meta.isDirectory() ||
    meta.uid !== process.getuid?.() ||
    (meta.mode & 0o077) !== 0
  )
    throw new Error("state_permissions_invalid");
  return path;
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
    if (replace) {
      try {
        const m = await lstat(path);
        if (
          !m.isFile() ||
          m.uid !== process.getuid?.() ||
          (m.mode & 0o077) !== 0
        )
          throw new Error("credential_permissions_invalid");
      } catch (e) {
        if (!(e && typeof e === "object" && "code" in e && e.code === "ENOENT"))
          throw e;
      }
    }
    await writeFile(path, value, {
      mode: 0o600,
      flag: replace
        ? constants.O_WRONLY |
          constants.O_TRUNC |
          constants.O_CREAT |
          constants.O_NOFOLLOW
        : "wx",
    });
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
    const meta = await lstat(path);
    if (
      !meta.isFile() ||
      (meta.mode & 0o077) !== 0 ||
      meta.uid !== process.getuid?.()
    )
      throw new Error();
    return (await readFile(path, "utf8")).trim();
  } catch {
    throw new Error("credential_unavailable");
  }
}
