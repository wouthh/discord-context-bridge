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
  writeFile,
  link,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSecret, readSecret } from "../packages/service/src/secrets.js";
import {
  createLocalConfiguration,
  rotateLocalCredential,
} from "../packages/service/src/setup.js";
import { configSchema } from "../packages/service/src/config.js";
import { Store } from "../packages/service/src/store.js";
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
test("generated configuration and credentials stay canonical after a safe alias is retargeted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-setup-alias-"));
  const previous = process.env.BRIDGE_STATE_DIR;
  const safe = join(dir, "private");
  const checkout = join(dir, "checkout");
  const alias = join(dir, "alias");
  const noKeyring = async () => {
    throw new Error("synthetic-keyring-unavailable");
  };
  try {
    await mkdir(safe, { mode: 0o700 });
    await mkdir(checkout, { mode: 0o700 });
    await promisify(execFile)("git", ["init", "--quiet", checkout]);
    await symlink(safe, alias);
    process.env.BRIDGE_STATE_DIR = join(alias, "state");
    let retargeted = false;
    const path = await createLocalConfiguration(async (name, value) => {
      if (!retargeted) {
        await rm(alias);
        await symlink(checkout, alias);
        retargeted = true;
      }
      return saveSecret(name, value, false, noKeyring);
    });
    assert.equal(path, join(safe, "state", "config.json"));
    assert.equal(process.env.BRIDGE_STATE_DIR, join(safe, "state"));
    const config = configSchema.parse(JSON.parse(await readFile(path, "utf8")));
    assert.equal(config.database, join(safe, "state", "bridge.sqlite"));
    const store = new Store(config);
    store.close();
    assert((await lstat(config.database)).isFile());
    for (const name of ["BRIDGE_PRODUCER_TOKEN", "BRIDGE_READER_TOKEN"])
      assert((await readSecret(name, noKeyring)).length > 0);
    await assert.rejects(lstat(join(checkout, "state")), { code: "ENOENT" });
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

test("rotation rejects repository, symlink, shared-file and hard-linked config overrides before credential IO", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-rotation-path-"));
  const previousState = process.env.BRIDGE_STATE_DIR,
    previousConfig = process.env.BRIDGE_CONFIG;
  try {
    const safe = join(dir, "private"),
      checkout = join(dir, "checkout");
    await mkdir(safe, { mode: 0o700 });
    await mkdir(checkout, { mode: 0o700 });
    await promisify(execFile)("git", ["init", "--quiet", checkout]);
    process.env.BRIDGE_STATE_DIR = safe;
    const path = await createLocalConfiguration(async () => "owner-only-file");
    const original = await readFile(path, "utf8");
    const repoConfig = join(checkout, "config.json");
    await writeFile(repoConfig, original, { mode: 0o600 });
    const symlinkConfig = join(safe, "config-link.json");
    await symlink(path, symlinkConfig);
    const sharedConfig = join(safe, "shared.json");
    await writeFile(sharedConfig, original, { mode: 0o644 });
    const linkedConfig = join(safe, "hard-link.json");
    await link(path, linkedConfig);
    await symlink(checkout, join(dir, "checkout-alias"));
    let credentialCalls = 0;
    for (const override of [
      repoConfig,
      join(dir, "checkout-alias", "config.json"),
      symlinkConfig,
      sharedConfig,
      linkedConfig,
    ]) {
      process.env.BRIDGE_CONFIG = override;
      await assert.rejects(
        rotateLocalCredential("reader", async () => {
          credentialCalls++;
          return "owner-only-file";
        }),
      );
      assert.equal(await readFile(override, "utf8"), original);
    }
    assert.equal(credentialCalls, 0);
    assert.equal(await readFile(path, "utf8"), original);
  } finally {
    if (previousState === undefined) delete process.env.BRIDGE_STATE_DIR;
    else process.env.BRIDGE_STATE_DIR = previousState;
    if (previousConfig === undefined) delete process.env.BRIDGE_CONFIG;
    else process.env.BRIDGE_CONFIG = previousConfig;
    await rm(dir, { recursive: true, force: true });
  }
});
test("rotation pins the canonical private config inode when a safe parent alias is retargeted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-rotation-alias-"));
  const previousState = process.env.BRIDGE_STATE_DIR,
    previousConfig = process.env.BRIDGE_CONFIG;
  try {
    const safe = join(dir, "private"),
      checkout = join(dir, "checkout"),
      alias = join(dir, "alias");
    await mkdir(safe, { mode: 0o700 });
    await mkdir(checkout, { mode: 0o700 });
    await promisify(execFile)("git", ["init", "--quiet", checkout]);
    process.env.BRIDGE_STATE_DIR = safe;
    const path = await createLocalConfiguration(async () => "owner-only-file");
    const original = await readFile(path, "utf8");
    await writeFile(join(checkout, "config.json"), original, { mode: 0o600 });
    await symlink(safe, alias);
    process.env.BRIDGE_CONFIG = join(alias, "config.json");
    let hash = "";
    await rotateLocalCredential("reader", async (name, value, replace) => {
      assert.equal(name, "BRIDGE_READER_TOKEN");
      assert.equal(replace, true);
      hash = (await import("../packages/service/src/auth.js")).tokenHash(value);
      await rm(alias);
      await symlink(checkout, alias);
      return "owner-only-file";
    });
    const updated = configSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
    assert.equal(updated.auth.mode, "local");
    if (updated.auth.mode === "local")
      assert.equal(
        updated.auth.credentials.find((g) => g.role === "reader")!.tokenHash,
        hash,
      );
    assert.equal((await stat(path)).mode & 0o077, 0);
    assert.equal(
      await readFile(join(checkout, "config.json"), "utf8"),
      original,
    );
  } finally {
    if (previousState === undefined) delete process.env.BRIDGE_STATE_DIR;
    else process.env.BRIDGE_STATE_DIR = previousState;
    if (previousConfig === undefined) delete process.env.BRIDGE_CONFIG;
    else process.env.BRIDGE_CONFIG = previousConfig;
    await rm(dir, { recursive: true, force: true });
  }
});
