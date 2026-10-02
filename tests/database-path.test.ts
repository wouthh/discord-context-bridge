import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  chmodSync,
  linkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Store } from "../packages/service/src/store.js";
import { config, event, now, producer, reader } from "./fixtures.js";
function fixture(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-database-path-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test("database paths and aliases into Git are rejected before SQLite or directory creation", () =>
  fixture((dir) => {
    const checkout = join(dir, "checkout");
    mkdirSync(checkout, { mode: 0o700 });
    execFileSync("git", ["init", "--quiet", checkout]);
    const sentinel = join(checkout, "sentinel.sqlite");
    writeFileSync(sentinel, "Synthetic untouched file", { mode: 0o600 });
    const alias = join(dir, "alias");
    symlinkSync(checkout, alias);
    const fileAlias = join(dir, "file-alias.sqlite");
    symlinkSync(sentinel, fileAlias);
    for (const path of [
      join(checkout, "store.sqlite"),
      relative(process.cwd(), join(checkout, "store.sqlite")),
      join(alias, "missing", "store.sqlite"),
      fileAlias,
    ])
      assert.throws(
        () => new Store(config(path)),
        /database_(inside_repository|permissions_invalid)/,
      );
    assert.equal(existsSync(join(checkout, "store.sqlite")), false);
    assert.equal(existsSync(join(checkout, "missing")), false);
    assert.equal(readFileSync(sentinel, "utf8"), "Synthetic untouched file");
  }));
test("private canonical database and SQLite sidecars remain outside a retargeted alias", () =>
  fixture((dir) => {
    const safe = join(dir, "private"),
      checkout = join(dir, "checkout"),
      alias = join(dir, "alias");
    mkdirSync(safe, { mode: 0o700 });
    mkdirSync(checkout, { mode: 0o700 });
    execFileSync("git", ["init", "--quiet", checkout]);
    symlinkSync(safe, alias);
    const cfg = config(join(alias, "state", "store.sqlite"));
    const store = new Store(cfg, () => now);
    try {
      assert.equal(cfg.database, join(safe, "state", "store.sqlite"));
      rmSync(alias);
      symlinkSync(checkout, alias);
      store.ingest(producer, [event()]);
      for (const path of [
        cfg.database,
        `${cfg.database}-wal`,
        `${cfg.database}-shm`,
      ])
        assert.equal(statSync(path).mode & 0o077, 0);
      assert.equal(existsSync(join(checkout, "state")), false);
      const second = new Store(config(cfg.database), () => now);
      try {
        assert.equal(
          (second.execute(reader, "read_messages") as { items: unknown[] })
            .items.length,
          1,
        );
      } finally {
        second.close();
      }
    } finally {
      store.close();
    }
  }));
test("unsafe database files, private parents and existing sidecars are refused without replacement", () =>
  fixture((dir) => {
    const shared = join(dir, "shared"),
      safe = join(dir, "private");
    mkdirSync(shared, { mode: 0o755 });
    mkdirSync(safe, { mode: 0o700 });
    assert.throws(
      () => new Store(config(join(shared, "store.sqlite"))),
      /database_permissions_invalid/,
    );
    assert.equal(existsSync(join(shared, "store.sqlite")), false);
    const file = join(safe, "store.sqlite");
    writeFileSync(file, "Synthetic untouched file", { mode: 0o644 });
    assert.throws(
      () => new Store(config(file)),
      /database_permissions_invalid/,
    );
    chmodSync(file, 0o600);
    linkSync(file, join(safe, "linked.sqlite"));
    assert.throws(
      () => new Store(config(file)),
      /database_permissions_invalid/,
    );
    rmSync(join(safe, "linked.sqlite"));
    const sidecar = `${file}-wal`;
    symlinkSync(file, sidecar);
    assert.throws(
      () => new Store(config(file)),
      /database_permissions_invalid/,
    );
    assert.equal(readFileSync(file, "utf8"), "Synthetic untouched file");
  }));
