import {
  realpathSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  constants,
} from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
function missing(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
/** SQLite opens by filename: validate a canonical private directory before handing it one. */
export function privateDatabasePath(input: string) {
  const requested = resolve(input);
  try {
    if (!lstatSync(requested).isFile())
      throw new Error("database_permissions_invalid");
  } catch (error) {
    if (!missing(error)) throw error;
  }
  let ancestor = dirname(requested);
  const suffix: string[] = [];
  while (true) {
    try {
      ancestor = join(realpathSync(ancestor), ...suffix);
      break;
    } catch (error) {
      if (!missing(error)) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  let parent = ancestor;
  while (true) {
    try {
      lstatSync(join(parent, ".git"));
      throw new Error("database_inside_repository");
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  mkdirSync(ancestor, { recursive: true, mode: 0o700 });
  const directory = lstatSync(ancestor);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  )
    throw new Error("database_permissions_invalid");
  const path = join(ancestor, basename(requested));
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const meta = lstatSync(candidate);
      if (
        !meta.isFile() ||
        meta.uid !== process.getuid?.() ||
        (meta.mode & 0o077) !== 0 ||
        meta.nlink !== 1
      )
        throw new Error("database_permissions_invalid");
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  // Create without following/replacing another inode and without permissive defaults.
  try {
    const file = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(file);
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ))
      throw error;
  }
  return path;
}
