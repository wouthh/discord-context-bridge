import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  symlink,
  rm,
  writeFile,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
const { safeCheckout } = (await import(
  new URL("../scripts/check-vencord.mjs", import.meta.url).href
)) as {
  safeCheckout: (
    target: string,
  ) => Promise<{ root: string; destination: string }>;
};
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(
    "/tmp/discord-context-bridge-vencord-safety-",
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test("accepts actual temporary checkout with absent plugin destination", () =>
  fixture(async (dir) => {
    await mkdir(join(dir, "src/userplugins"), { recursive: true });
    assert.deepEqual(await safeCheckout(dir), {
      root: dir,
      destination: join(dir, "src/userplugins/discordContextBridge"),
    });
  }));
test("temporary symlink cannot disguise a non-temporary checkout", () =>
  fixture(async (dir) => {
    await symlink("/", join(dir, "alias"), "dir");
    await assert.rejects(
      safeCheckout(join(dir, "alias")),
      /Disposable temporary checkout required/,
    );
  }));
test("rejects symlinked destination ancestors and preserves unrelated target files", () =>
  fixture(async (dir) => {
    const outside = join(dir, "unrelated");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "preserve");
    const first = join(dir, "first");
    await mkdir(first);
    await symlink(outside, join(first, "src"), "dir");
    await assert.rejects(
      safeCheckout(first),
      /Unsafe checkout destination ancestor/,
    );
    const second = join(dir, "second");
    await mkdir(join(second, "src"), { recursive: true });
    await symlink(outside, join(second, "src/userplugins"), "dir");
    await assert.rejects(
      safeCheckout(second),
      /Unsafe checkout destination ancestor/,
    );
    assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "preserve");
  }));
test("rejects existing and dangling symlink plugin destinations", () =>
  fixture(async (dir) => {
    await mkdir(join(dir, "src/userplugins"), { recursive: true });
    const destination = join(dir, "src/userplugins/discordContextBridge");
    await symlink(join(dir, "missing"), destination, "dir");
    await assert.rejects(
      safeCheckout(dir),
      /Plugin destination already exists/,
    );
    await rm(destination);
    await mkdir(destination);
    await assert.rejects(
      safeCheckout(dir),
      /Plugin destination already exists/,
    );
  }));
