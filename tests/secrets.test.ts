import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, chmod, readFile, symlink } from "node:fs/promises";
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
