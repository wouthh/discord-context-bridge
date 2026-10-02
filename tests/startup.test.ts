import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { config } from "./fixtures.js";
import { Store } from "../packages/service/src/store.js";
const execute = promisify(execFile);
async function privateConfig(dir: string, port: number) {
  const settings = config(join(dir, "private.sqlite"));
  settings.port = port;
  settings.publicUrl = `http://127.0.0.1:${port}`;
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(settings), { mode: 0o600 });
  return { path, settings };
}
async function reservedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, port: address.port };
}
test("occupied loopback bind exits with fixed diagnostics and closes its synthetic database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-startup-bind-"));
  const { server, port } = await reservedPort();
  try {
    const { path, settings } = await privateConfig(dir, port);
    await assert.rejects(
      execute(
        process.execPath,
        ["--import", "tsx", "packages/service/src/main.ts"],
        {
          env: { ...process.env, BRIDGE_CONFIG: path },
          timeout: 10000,
        },
      ),
      (error: unknown) => {
        const result = error as {
          code: number;
          stdout: string;
          stderr: string;
        };
        assert.equal(result.code, 1);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "connector_start_failed\n");
        assert.equal(result.stderr.includes(dir), false);
        return true;
      },
    );
    const reopened = new Store(settings);
    try {
      assert.equal(
        reopened.db.pragma("wal_checkpoint(TRUNCATE)", { simple: true }),
        0,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});
for (const fault of [null, "checkpoint", "close"] as const) {
  test(`successful startup and signal shutdown ${fault ? `sanitizes ${fault} failure while closing` : "closes cleanly"}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-startup-close-"));
    const { server, port } = await reservedPort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const { path, settings } = await privateConfig(dir, port);
      const args = ["--import", "tsx"];
      if (fault) {
        const patch = join(dir, "synthetic-shutdown.mjs");
        const moduleUrl = pathToFileURL(
          createRequire(import.meta.url).resolve("better-sqlite3"),
        ).href;
        await writeFile(
          patch,
          `import Database from ${JSON.stringify(moduleUrl)};
` +
            (fault === "checkpoint"
              ? `const original=Database.prototype.pragma;Database.prototype.pragma=function(sql,...args){if(sql==='wal_checkpoint(TRUNCATE)')throw new Error('synthetic-private-path-or-content');return original.call(this,sql,...args);};\n`
              : `const original=Database.prototype.close;Database.prototype.close=function(){original.call(this);throw new Error('synthetic-private-path-or-content');};\n`),
          { mode: 0o600 },
        );
        args.push("--import", patch);
      }
      args.push("packages/service/src/main.ts");
      child = spawn(process.execPath, args, {
        env: { ...process.env, BRIDGE_CONFIG: path },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      const exited = new Promise<number | null>((resolve, reject) => {
        child!.once("error", reject);
        child!.once("exit", (code) => resolve(code));
      });
      const ready = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("synthetic-startup-timeout")),
          10000,
        );
        child!.stdout!.on("data", (chunk) => {
          stdout += chunk.toString();
          if (stdout.includes("connector_ready_loopback")) {
            clearTimeout(timeout);
            resolve();
          }
        });
        child!.once("exit", () => {
          clearTimeout(timeout);
          reject(new Error("synthetic-early-exit"));
        });
      });
      child.stderr!.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      await ready;
      child.kill("SIGTERM");
      const shutdownTimeout = setTimeout(() => child?.kill("SIGKILL"), 10000);
      const code = await exited;
      clearTimeout(shutdownTimeout);
      assert.equal(code, fault ? 1 : 0);
      assert.equal(stdout, "connector_ready_loopback\n");
      assert.equal(stderr, fault ? "connector_start_failed\n" : "");
      assert.equal(stderr.includes(dir), false);
      const reopened = new Store(settings);
      reopened.close();
    } finally {
      if (child?.exitCode === null) child.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  });
}
