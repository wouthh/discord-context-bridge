import type { IpcMainInvokeEvent } from "electron";
// Native HTTPS transport avoids renderer CSP restrictions; only the connector
// origin is contacted. No Discord HTTP/API access or arbitrary file access.
export async function request(
  _event: IpcMainInvokeEvent,
  origin: string,
  token: string,
  path: string,
  payload = "",
) {
  const url = new URL(origin);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error("invalid_connector_origin");
  if (
    !["/v1/ingest", "/v1/source-control", "/v1/producer-scope"].includes(
      path,
    ) ||
    // Match the protocol HTTP ingress ceiling; source is copied standalone.
    Buffer.byteLength(payload, "utf8") > 1024 * 1024 ||
    token.length > 4096 ||
    !token
  )
    throw new Error("invalid_export");
  const response = await fetch(url.origin + path, {
    method: path === "/v1/producer-scope" ? "GET" : "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: path === "/v1/producer-scope" ? undefined : payload,
  });
  if (!response.ok) throw new Error("connector_request_failed");
  if (path === "/v1/producer-scope") {
    const text = await response.text();
    if (text.length > 100000) throw new Error("invalid_scope_response");
    return JSON.parse(text);
  }
  return undefined;
}
