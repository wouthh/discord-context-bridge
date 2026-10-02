import { build } from "esbuild";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
const out = "dist/vencord/discordContextBridge";
await mkdir(out, { recursive: true });
await build({
  entryPoints: ["packages/plugin/src/core.ts"],
  outfile: out + "/core.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  legalComments: "inline",
});
await copyFile("packages/plugin/src/vencord.ts", out + "/index.ts");
await copyFile("packages/plugin/src/native.ts", out + "/native.ts");
await writeFile(
  out + "/core.d.ts",
  await readFile("packages/plugin/src/public-api.d.ts", "utf8"),
);

await copyFile("node_modules/zod/LICENSE", out + "/ZOD-LICENSE");
await copyFile("LICENSE", out + "/LICENSE");
