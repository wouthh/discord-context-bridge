import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readSecret } from "../packages/service/src/secrets.js";
import { pathToFileURL } from "node:url";
export async function readMcp(base: string, token: string) {
  const url = new URL(base);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("https_required");
  const client = new Client({
    name: "generic-context-reader",
    version: "0.1.0",
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", url), {
        requestInit: {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
        },
      }),
    );
    const result = await client.callTool({
      name: "read_messages",
      arguments: { limit: 10 },
    });
    if (result.isError) throw new Error("reader_failed");
    return JSON.parse((result.content as { text: string }[])[0].text);
  } finally {
    await client.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const data = await readMcp(
      process.env.BRIDGE_URL ?? "http://127.0.0.1:8787",
      await readSecret("BRIDGE_READER_TOKEN"),
    );
    console.info(`scoped_items_received: ${data.items.length}`);
  } catch {
    console.error("example_reader_failed");
    process.exitCode = 1;
  }
}
