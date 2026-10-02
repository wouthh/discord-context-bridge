import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { createApp } from "./http.js";
process.umask(0o077);
try {
  const config = loadConfig();
  const store = new Store(config);
  const server = createApp(store).listen(config.port, "127.0.0.1", () =>
    console.info("connector_ready_loopback"),
  );
  const timer = setInterval(() => store.sweep(), 60000);
  timer.unref();
  const close = () => {
    clearInterval(timer);
    server.close(() => {
      store.db.pragma("wal_checkpoint(TRUNCATE)");
      store.close();
    });
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
} catch {
  console.error("connector_start_failed");
  process.exitCode = 1;
}
