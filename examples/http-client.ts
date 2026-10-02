import { readSecret } from "../packages/service/src/secrets.js";
import { pathToFileURL } from "node:url";
export async function readHttp(base: string, token: string) {
  const url = new URL(base);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("https_required");
  const response = await fetch(new URL("/v1/read_messages", url), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ limit: 10 }),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("reader_failed");
  return response.json();
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const data = await readHttp(
      process.env.BRIDGE_URL ?? "http://127.0.0.1:8787",
      await readSecret("BRIDGE_READER_TOKEN"),
    );
    console.info(`scoped_items_received: ${data.items.length}`);
  } catch {
    console.error("example_reader_failed");
    process.exitCode = 1;
  }
}
