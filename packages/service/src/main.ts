import { createServer } from "node:http";
import { loadConfig, loopbackHost } from "./config.js";
import { Store } from "./store.js";
import { createApp } from "./http.js";
process.umask(0o077);
let store: Store | undefined;
let finished = false,
  failed = false;
const fail = () => {
  if (!failed) console.error("connector_start_failed");
  failed = true;
  process.exitCode = 1;
};
const finish = () => {
  if (finished) return;
  finished = true;
  if (!store) return;
  try {
    store.db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    fail();
  }
  try {
    store.close();
  } catch {
    fail();
  }
};
let shutdown = finish;
try {
  const config = await loadConfig();
  store = new Store(config);
  const server = createServer(createApp(store));
  let closing = false;
  const timer = setInterval(() => {
    try {
      store?.sweep();
    } catch {
      fail();
      shutdown();
    }
  }, 60000);
  timer.unref();
  shutdown = () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    try {
      server.close(finish);
      server.closeAllConnections();
    } catch {
      fail();
      finish();
    }
  };
  // Register before listen: bind failures arrive asynchronously.
  server.on("error", () => {
    fail();
    shutdown();
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.listen(config.port, loopbackHost(config), () =>
    console.info("connector_ready_loopback"),
  );
} catch {
  fail();
  shutdown();
}
