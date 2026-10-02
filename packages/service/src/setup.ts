import { password, select, confirm } from "@inquirer/prompts";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  saveSecret,
  privateStateDir,
  openPrivateConfiguration,
} from "./secrets.js";
import { configSchema } from "./config.js";
import { tokenHash } from "./auth.js";
export async function createLocalConfiguration(storeCredential = saveSecret) {
  const directory = await privateStateDir();
  process.env.BRIDGE_STATE_DIR = directory;
  const producer = randomBytes(32).toString("base64url"),
    reader = randomBytes(32).toString("base64url");
  const config = {
    ownerId: "owner",
    database: join(directory, "bridge.sqlite"),
    sources: [],
    auth: {
      mode: "local",
      credentials: [
        {
          subject: "local-producer",
          role: "producer",
          sourceIds: ["server-reader", "personal-client"],
          tokenHash: tokenHash(producer),
          expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400,
        },
        {
          subject: "local-reader",
          role: "reader",
          sourceIds: ["server-reader", "personal-client"],
          tokenHash: tokenHash(reader),
          expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400,
        },
      ],
    },
  };
  // Refuse to replace existing configuration or fallback files.
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify(config, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  await storeCredential("BRIDGE_PRODUCER_TOKEN", producer);
  await storeCredential("BRIDGE_READER_TOKEN", reader);
  return join(directory, "config.json");
}
export async function rotateLocalCredential(
  role: "reader" | "producer",
  storeCredential = saveSecret,
) {
  const directory = await privateStateDir();
  process.env.BRIDGE_STATE_DIR = directory;
  const file = await openPrivateConfiguration(
    process.env.BRIDGE_CONFIG ?? join(directory, "config.json"),
  );
  try {
    const cfg = configSchema.parse(JSON.parse(await file.readFile("utf8")));
    if (cfg.auth.mode !== "local")
      throw new Error("local_configuration_required");
    const grant = cfg.auth.credentials.find(
      (g) => g.role === role && g.subject === `local-${role}`,
    );
    if (!grant) throw new Error("local_grant_missing");
    const token = randomBytes(32).toString("base64url");
    await storeCredential(
      role === "reader" ? "BRIDGE_READER_TOKEN" : "BRIDGE_PRODUCER_TOKEN",
      token,
      true,
    );
    grant.tokenHash = tokenHash(token);
    grant.expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400;
    const data = Buffer.from(JSON.stringify(cfg, null, 2) + "\n");
    let offset = 0;
    while (offset < data.length) {
      const result = await file.write(
        data,
        offset,
        data.length - offset,
        offset,
      );
      if (!result.bytesWritten) throw new Error("configuration_write_failed");
      offset += result.bytesWritten;
    }
    await file.truncate(data.length);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function main() {
  process.umask(0o077);
  try {
    const action = await select({
      message: "Local setup (credentials never printed)",
      choices: [
        {
          name: "Create disabled loopback configuration and local reader/producer credentials",
          value: "config",
        },
        { name: "Enter DISCORD_BOT_TOKEN manually", value: "bot" },
        {
          name: "Rotate generated local reader/producer credential (stop connector first)",
          value: "rotate",
        },
        {
          name: "Enter issuer-provided BRIDGE_PRODUCER_TOKEN",
          value: "producer",
        },
        { name: "Enter issuer-provided BRIDGE_READER_TOKEN", value: "reader" },
      ],
    });
    if (action === "config") {
      await createLocalConfiguration();
      console.info("configuration_created_sources_disabled");
    } else if (action === "rotate") {
      if (
        !(await confirm({
          message:
            "Have you stopped the connector and paused producers before rotating?",
          default: false,
        }))
      )
        throw new Error();
      const role = await select({
        message: "Credential to rotate",
        choices: [
          { name: "Local reader", value: "reader" },
          { name: "Local producer", value: "producer" },
        ],
      });
      await rotateLocalCredential(role);
      console.info("local_credential_rotated_restart_required");
    } else {
      const name =
        action === "bot"
          ? "DISCORD_BOT_TOKEN"
          : action === "producer"
            ? "BRIDGE_PRODUCER_TOKEN"
            : "BRIDGE_READER_TOKEN";
      const token = await password({
        message: `${name} (hidden input)`,
        mask: "*",
      });
      if (
        await confirm({
          message:
            "Store this credential in the OS keyring, or a new owner-only file outside the repository?",
          default: false,
        })
      )
        console.info(`credential_saved_${await saveSecret(name, token, true)}`);
    }
  } catch {
    console.error("setup_failed_no_secret_output");
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
