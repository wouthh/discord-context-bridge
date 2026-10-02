import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /mfa\.[\w-]{20,}/,
  /[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{25,}/,
  /(?:ghp_|sk-)[A-Za-z0-9_-]{20,}/,
  /\/(?:home|Users)\/[A-Za-z0-9_-]+\//,
  /C:\\Users\\/i,
  /https?:\/\/[^\s/]+:[^\s/]+@/,
];
const git = (args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const files = git([
  "ls-files",
  "--cached",
  "--others",
  "--exclude-standard",
  "-z",
])
  .split("\0")
  .filter(Boolean);
let failures = 0;
function check(text, label) {
  if (patterns.some((p) => p.test(text))) {
    console.error(`publication_scan_failed: ${label}`);
    failures++;
  }
}
for (const file of files) {
  if (
    /(?:^|\/)(?:credentials\.json|config\.local\.json|.*\.sqlite.*|.*\.secret|\.env)$/.test(
      file,
    )
  ) {
    console.error(`private_file_tracked: ${file}`);
    failures++;
  }
  check(readFileSync(file, "utf8"), file);
}
let commits = [];
try {
  commits = git(["rev-list", "--all"]).trim().split("\n").filter(Boolean);
} catch {
  /* Unborn repository is checked by worktree scan. */
}
for (const commit of commits) {
  check(git(["show", "-s", "--format=%B", commit]), "commit message");
}
if (commits.length) {
  const objects = git(["rev-list", "--objects", "--all"]).trim().split("\n");
  for (const object of objects) {
    const hash = object.split(" ")[0];
    if (git(["cat-file", "-t", hash]).trim() === "blob")
      check(
        git(["cat-file", "blob", hash]),
        `history blob ${hash.slice(0, 12)}`,
      );
  }
}
if (failures) process.exitCode = 1;
else
  console.info(
    `publication_scan_passed: ${files.length} worktree files; ${commits.length} commits; pattern scan is not comprehensive personal-data redaction`,
  );
