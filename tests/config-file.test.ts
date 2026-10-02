import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  link,
  chmod,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config as fixtureConfig } from "./fixtures.js";
import { loadConfig } from "../packages/service/src/config.js";
const execute = promisify(execFile);
test("runtime configuration accepts private read-only canonical parent aliases and rejects unsafe files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-runtime-config-"));
  const previous = process.env.BRIDGE_CONFIG;
  try {
    const safe = join(dir, "private"),
      checkout = join(dir, "checkout"),
      shared = join(dir, "shared");
    await mkdir(safe, { mode: 0o700 });
    await mkdir(checkout, { mode: 0o700 });
    await mkdir(shared, { mode: 0o755 });
    await execute("git", ["init", "--quiet", checkout]);
    const content = JSON.stringify(fixtureConfig());
    const path = join(safe, "config.json");
    await writeFile(path, content, { mode: 0o400 });
    await symlink(safe, join(dir, "alias"));
    process.env.BRIDGE_CONFIG = join(dir, "alias", "config.json");
    assert.equal((await loadConfig()).ownerId, "synthetic-owner");
    const repositoryFile = join(checkout, "config.json"),
      permissive = join(safe, "shared.json"),
      publicParent = join(shared, "config.json"),
      symbolic = join(safe, "symbolic.json"),
      hard = join(safe, "hard.json");
    await writeFile(repositoryFile, content, { mode: 0o600 });
    await writeFile(permissive, content, { mode: 0o644 });
    await writeFile(publicParent, content, { mode: 0o600 });
    await symlink(path, symbolic);
    await link(path, hard);
    for (const value of [
      repositoryFile,
      permissive,
      publicParent,
      symbolic,
      hard,
    ]) {
      process.env.BRIDGE_CONFIG = value;
      await assert.rejects(loadConfig(), /configuration_invalid/);
    }
    await rm(hard);
    await chmod(path, 0o600);
    process.env.BRIDGE_CONFIG = path;
    assert.equal((await loadConfig()).database, ":memory:");
  } finally {
    if (previous === undefined) delete process.env.BRIDGE_CONFIG;
    else process.env.BRIDGE_CONFIG = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
test("service and owner-control CLIs reject shared runtime config without dumping contents or paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-config-cli-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify(fixtureConfig()), { mode: 0o644 });
    for (const [entry, expected] of [
      ["main.ts", "connector_start_failed"],
      ["control.ts", "control_failed"],
    ]) {
      await assert.rejects(
        execute(
          process.execPath,
          ["--import", "tsx", `packages/service/src/${entry}`, "status"],
          { env: { ...process.env, BRIDGE_CONFIG: path }, timeout: 10000 },
        ),
        (error: unknown) => {
          const result = error as {
            code: number;
            stdout: string;
            stderr: string;
          };
          assert.equal(result.code, 1);
          assert.equal(result.stdout, "");
          assert.equal(result.stderr.trim(), expected);
          return true;
        },
      );
    }
    await chmod(path, 0o400);
    const result = await execute(
      process.execPath,
      ["--import", "tsx", "packages/service/src/control.ts", "status"],
      { env: { ...process.env, BRIDGE_CONFIG: path }, timeout: 10000 },
    );
    assert.equal(JSON.parse(result.stdout).sources[0].id, "personal-client");
    assert.equal(result.stderr, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
