import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  stat,
  chmod,
  readFile,
  symlink,
  mkdir,
  lstat,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSecret, readSecret } from "../packages/service/src/secrets.js";
test("synthetic secrets fallback is private, rejects overwrite/shared files and never needs a real keyring", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-secret-"));
  const previous = process.env.BRIDGE_STATE_DIR;
  process.env.BRIDGE_STATE_DIR = dir;
  const noKeyring = async () => {
    throw new Error("synthetic-keyring-unavailable");
  };
  try {
    const value = "synthetic-credential-for-file-test";
    assert.equal(
      await saveSecret("DISCORD_BOT_TOKEN", value, false, noKeyring),
      "owner-only-file",
    );
    const path = join(dir, "DISCORD_BOT_TOKEN.secret");
    assert.equal((await stat(path)).mode & 0o077, 0);
    assert.equal(await readSecret("DISCORD_BOT_TOKEN", noKeyring), value);
    await assert.rejects(
      saveSecret("DISCORD_BOT_TOKEN", "synthetic-next", false, noKeyring),
    );
    await saveSecret("DISCORD_BOT_TOKEN", "synthetic-next", true, noKeyring);
    assert.equal(await readFile(path, "utf8"), "synthetic-next");
    await chmod(path, 0o644);
    await assert.rejects(readSecret("DISCORD_BOT_TOKEN", noKeyring));
    await assert.rejects(
      saveSecret("DISCORD_BOT_TOKEN", "synthetic-next", true, noKeyring),
    );
    await symlink(path, join(dir, "BRIDGE_READER_TOKEN.secret"));
    await assert.rejects(readSecret("BRIDGE_READER_TOKEN", noKeyring));
    await assert.rejects(
      saveSecret("PERSONAL_DISCORD_TOKEN", "synthetic", false, noKeyring),
    );
  } finally {
    if (previous === undefined) delete process.env.BRIDGE_STATE_DIR;
    else process.env.BRIDGE_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
test("state aliases into a Git checkout are rejected before creating missing components or credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-secret-alias-"));
  const previous = process.env.BRIDGE_STATE_DIR;
  const checkout = join(dir, "checkout");
  const noKeyring = async () => {
    throw new Error("synthetic-keyring-unavailable");
  };
  let keyringCalls = 0;
  const keyring = async () => {
    keyringCalls++;
    return "";
  };
  try {
    await mkdir(checkout, { mode: 0o700 });
    await promisify(execFile)("git", ["init", "--quiet", checkout]);
    await mkdir(join(checkout, "subdir"), { mode: 0o700 });
    await symlink(join(checkout, "subdir"), join(dir, "alias"));
    for (const suffix of ["state", join("not-created", "nested", "state")]) {
      process.env.BRIDGE_STATE_DIR = join(dir, "alias", suffix);
      await assert.rejects(
        saveSecret("DISCORD_BOT_TOKEN", "synthetic-secret", false, keyring),
        /state_inside_repository/,
      );
      await assert.rejects(
        saveSecret("DISCORD_BOT_TOKEN", "synthetic-secret", false, noKeyring),
        /state_inside_repository/,
      );
      await assert.rejects(lstat(join(checkout, "subdir", suffix)), {
        code: "ENOENT",
      });
    }
    assert.equal(keyringCalls, 0);
    await assert.rejects(lstat(join(checkout, "subdir", "not-created")), {
      code: "ENOENT",
    });
    await assert.rejects(
      lstat(join(checkout, "subdir", "state", "DISCORD_BOT_TOKEN.secret")),
      { code: "ENOENT" },
    );
    // A safe alias resolves to its canonical private destination outside Git.
    const external = join(dir, "private");
    await mkdir(external, { mode: 0o700 });
    await symlink(external, join(dir, "safe-alias"));
    process.env.BRIDGE_STATE_DIR = join(dir, "safe-alias", "new-state");
    assert.equal(
      await saveSecret(
        "DISCORD_BOT_TOKEN",
        "synthetic-secret",
        false,
        noKeyring,
      ),
      "owner-only-file",
    );
    assert.equal(
      await readSecret("DISCORD_BOT_TOKEN", noKeyring),
      "synthetic-secret",
    );
    assert.equal(
      (await lstat(join(external, "new-state", "DISCORD_BOT_TOKEN.secret")))
        .mode & 0o077,
      0,
    );
  } finally {
    if (previous === undefined) delete process.env.BRIDGE_STATE_DIR;
    else process.env.BRIDGE_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
