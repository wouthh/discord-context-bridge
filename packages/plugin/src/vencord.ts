import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, type PluginNative } from "@utils/types";
import { ChannelStore, UserStore, React } from "@webpack/common";
import {
  PersonalCapture,
  connectorUrl,
  sourceMatches,
  planControlRetry,
  parseControlBarrier,
  createControlBarrier,
  confirmControlBarrier,
  controlBarrierMinimum,
  type ControlBarrier,
  type ClientEvent,
} from "./core";
const Native = VencordNative.pluginHelpers.DiscordContextBridge as PluginNative<
  typeof import("./native")
>;
let capture: PersonalCapture | undefined;
let token = "";
let epoch = 0;
let activeEndpoint = "";
let revocation: Promise<void> | undefined;
let controlBusy = false;
let pendingControl: { barrier: ControlBarrier; key: string } | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let status = "Paused. No credential loaded.";
const settings = definePluginSettings({
  revokeBarrier: {
    type: OptionType.STRING,
    description: "Content-free original control metadata and confirmation",
    default: "",
    hidden: true,
  },
  observing: {
    type: OptionType.BOOLEAN,
    description: "Allow observation after explicit configuration and Resume",
    default: false,
    onChange: () => scopeChange(),
  },
  endpoint: {
    type: OptionType.STRING,
    description:
      "Connector HTTPS origin (loopback HTTP permitted for development)",
    default: "http://127.0.0.1:8787",
    onChange: () => scopeChange(),
  },
  sourceId: {
    type: OptionType.STRING,
    description: "Personal source ID from connector config",
    default: "",
    onChange: () => scopeChange(),
  },
  accountId: {
    type: OptionType.STRING,
    description: "Explicit Discord account ID authorized in connector config",
    default: "",
    onChange: () => scopeChange(),
  },
  conversations: {
    type: OptionType.STRING,
    description:
      "Comma-separated selected DM/group DM IDs; revoke remotely BEFORE removing",
    default: "",
    onChange: () => scopeChange(),
  },
  generation: {
    type: OptionType.NUMBER,
    description:
      "Current connector source generation; revocation requires a new manually configured generation",
    default: 1,
    onChange: () => scopeChange(),
  },
  queueLimit: {
    type: OptionType.NUMBER,
    description: "Memory queue limit (1–1000)",
    default: 500,
    onChange: () => pause(),
  },
  queueMinutes: {
    type: OptionType.NUMBER,
    description: "Memory queue expiry (1–60 minutes)",
    default: 60,
    onChange: () => pause(),
  },
});
function pause() {
  epoch++;
  capture?.pause();
  token = "";
  status = pendingControl
    ? "Paused; export credential and queue cleared. Pending remote control retains a session-only retry credential."
    : "Paused; local queue and session credential cleared.";
}
function source() {
  return {
    id: settings.store.sourceId,
    type: "personal" as const,
    accountId: settings.store.accountId,
    enabled: settings.store.observing,
    generation: settings.store.generation,
    conversations: settings.store.conversations
      .split(",")
      .map((id) => ({ id: id.trim() }))
      .filter((c) => c.id),
  };
}
async function retryControl() {
  const pending = pendingControl;
  if (!pending || controlBusy) return;
  controlBusy = true;
  try {
    const scope = await Native.request(
      pending.barrier.endpoint,
      pending.key,
      "/v1/producer-scope",
    );
    if (pendingControl !== pending) return;
    const remote = Array.isArray(scope?.sources)
      ? scope.sources.find(
          (s: ReturnType<typeof source>) =>
            s.id === pending.barrier.original.id,
        )
      : undefined;
    const plan = planControlRetry(
      pending.barrier.original,
      pending.barrier.action,
      pending.barrier.conversationId,
      remote,
      scope?.conversationScopeComplete === true,
    );
    if (plan.state === "blocked") throw new Error("control_scope_changed");
    if (plan.state === "send")
      await Native.request(
        pending.barrier.endpoint,
        pending.key,
        "/v1/source-control",
        JSON.stringify({
          sourceId: pending.barrier.original.id,
          accountId: pending.barrier.original.accountId,
          generation: plan.generation,
          action: pending.barrier.action,
          ...(pending.barrier.conversationId
            ? { conversationId: pending.barrier.conversationId }
            : {}),
        }),
      );
    if (pendingControl !== pending) return;
    const generation =
      plan.state === "send" ? plan.generation + 1 : remote.generation;
    settings.store.revokeBarrier = JSON.stringify(
      confirmControlBarrier(pending.barrier, generation),
    );
    pendingControl = undefined;
    capture = undefined;
    status =
      "Remote control acknowledged. Owner must configure enabled scope/current generation before Resume.";
  } catch {
    status =
      "Remote revocation/purge UNCONFIRMED. Export stopped. Retry remote control or use owner command.";
  } finally {
    controlBusy = false;
  }
}
function beginControl(
  original: PersonalCapture["queue"]["source"],
  action: "purge" | "revoke",
  endpoint: string,
  key: string,
  conversationId?: string,
) {
  try {
    const existing = parseControlBarrier(settings.store.revokeBarrier);
    if (pendingControl || (existing && !existing.confirmed)) {
      status =
        "Original control remains unconfirmed. Retry it or recover with its manually entered credential; new controls cannot overwrite it.";
      return;
    }
    const barrier = createControlBarrier(
      original,
      action,
      endpoint,
      conversationId,
    );
    settings.store.revokeBarrier = JSON.stringify(barrier);
    capture = undefined;
    if (!key) {
      status =
        "Original control metadata saved; export stopped. Enter its producer credential and Resume to recover it.";
      return;
    }
    pendingControl = { barrier, key };
    status = "Original control pending; export stopped.";
    revocation = retryControl();
  } catch {
    status =
      "Stored control metadata invalid. Export stopped; owner recovery required.";
  }
}
function scopeChange() {
  const old = capture?.queue.source,
    key = token,
    endpoint = activeEndpoint;
  pause();
  if (old && endpoint) beginControl(old, "revoke", endpoint, key);
}
async function resume(credential: string) {
  pause();
  const attempt = epoch;
  try {
    if (revocation) await revocation;
    if (pendingControl) throw new Error("remote_control_unconfirmed");
    if (!credential || credential.length > 4096)
      throw new Error("invalid_credential");
    const barrier = parseControlBarrier(settings.store.revokeBarrier);
    if (barrier && !barrier.confirmed) {
      pendingControl = { barrier, key: credential };
      status = "Recovering original control only; no observation or export.";
      revocation = retryControl();
      await revocation;
      return;
    }
    const endpoint = connectorUrl(settings.store.endpoint);
    const cfg = source();
    const remote = await Native.request(
      endpoint,
      credential,
      "/v1/producer-scope",
    );
    const minimum = controlBarrierMinimum(barrier, cfg, endpoint);
    if (
      attempt !== epoch ||
      !remote ||
      !Array.isArray(remote.sources) ||
      !remote.sources.some((s: ReturnType<typeof source>) =>
        sourceMatches(
          cfg,
          s,
          minimum,
          remote.conversationScopeComplete === true,
        ),
      )
    )
      throw new Error("remote_scope_mismatch");
    activeEndpoint = endpoint;
    if (!credential || credential.length > 4096)
      throw new Error("invalid_credential");
    const limit = settings.store.queueLimit,
      minutes = settings.store.queueMinutes;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      !Number.isInteger(minutes) ||
      minutes < 1 ||
      minutes > 60
    )
      throw new Error("invalid_queue_bounds");
    if (!source().conversations.length) throw new Error("select_conversations");
    capture = new PersonalCapture(
      cfg,
      () => UserStore.getCurrentUser()?.id,
      (id) => ChannelStore.getChannel(id)?.type,
      Date.now,
      limit,
      minutes * 60000,
    );
    if (!capture.resume()) throw new Error("account_or_observation_mismatch");
    token = credential;
    status = "Observing selected conversations. Coverage is partial.";
  } catch {
    pause();
    status =
      "Resume rejected: authenticated remote scope/generation must exactly match settings and confirmed revocation barrier; check account/queue bounds.";
  }
}
async function flush() {
  if (!capture || !token) return;
  const key = token;
  const endpoint = settings.store.endpoint;
  await capture.export(async (events, health, signal) => {
    if (signal.aborted || key !== token) return;
    await Native.request(
      connectorUrl(endpoint),
      key,
      "/v1/ingest",
      JSON.stringify({ events, health }),
    );
  });
}
async function control(action: "purge" | "revoke", conversationId?: string) {
  if (
    conversationId !== undefined &&
    !/^[a-zA-Z0-9_-]{1,80}$/.test(conversationId)
  ) {
    status = "Enter the explicit conversation ID to revoke.";
    return;
  }
  if (conversationId !== undefined && !conversationId.trim()) {
    status = "Select a conversation ID before revoking it.";
    return;
  }
  const credential = token;
  const cfg = capture?.queue.source ?? source();
  const endpoint = activeEndpoint || connectorUrl(settings.store.endpoint);
  pause();
  beginControl(cfg, action, endpoint, credential, conversationId);
  if (revocation) await revocation;
}
function recoveryStatus() {
  try {
    const barrier = parseControlBarrier(settings.store.revokeBarrier);
    return barrier && !barrier.confirmed
      ? `Original ${barrier.action} pending for ${barrier.original.id} at ${barrier.endpoint}. Resume uses the entered credential only for that original control; then enter the desired source credential separately.`
      : "";
  } catch {
    return "Stored control metadata invalid. Export blocked; owner recovery required.";
  }
}
function Panel() {
  const [credential, setCredential] = React.useState("");
  const [conversation, setConversation] = React.useState("");
  const [, rerender] = React.useState(0);
  const run = (fn: () => void | Promise<void>) => () => {
    void Promise.resolve(fn()).finally(() => rerender((n) => n + 1));
  };
  return React.createElement(
    "div",
    {},
    React.createElement("p", {}, status),
    React.createElement("p", {}, recoveryStatus()),
    React.createElement(
      "p",
      {},
      JSON.stringify(capture?.queue.status() ?? { paused: true }),
    ),
    React.createElement(
      "p",
      {},
      "Only delivered DM/group DM events are observed. Offline gaps, unknown offline deletions and partial updates are possible. No complete inbox.",
    ),
    React.createElement("input", {
      type: "password",
      autoComplete: "off",
      "aria-label": "Session producer credential",
      placeholder: "Producer credential (session only)",
      value: credential,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setCredential(e.target.value),
    }),
    React.createElement(
      "button",
      {
        onClick: run(async () => {
          const key = credential;
          setCredential("");
          await resume(key);
        }),
      },
      "Resume with credential",
    ),
    React.createElement(
      "button",
      {
        onClick: run(() => {
          setCredential("");
          pause();
        }),
      },
      "Pause/disconnect and clear queue",
    ),
    React.createElement(
      "button",
      { onClick: run(() => control("purge")) },
      "Purge remote source",
    ),
    React.createElement("input", {
      "aria-label": "Conversation to revoke",
      value: conversation,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setConversation(e.target.value),
    }),
    React.createElement(
      "button",
      { onClick: run(() => control("revoke", conversation)) },
      "Revoke selected conversation remotely",
    ),
    React.createElement(
      "button",
      { onClick: run(() => control("revoke")) },
      "Revoke entire source",
    ),
    React.createElement(
      "button",
      { onClick: run(retryControl) },
      "Retry remote control",
    ),
    React.createElement("button", { onClick: run(() => {}) }, "Refresh status"),
  );
}
export default definePlugin({
  name: "DiscordContextBridge",
  description:
    "Explicitly scoped passive personal context export. Unofficial; partial coverage only.",
  authors: [{ name: "discord-context-bridge contributors", id: 0n }],
  settings,
  settingsAboutComponent: Panel,
  start() {
    pause();
    timer = setInterval(() => {
      void flush();
    }, 5000);
  },
  stop() {
    if (timer) clearInterval(timer);
    timer = undefined;
    pause();
    pendingControl = undefined;
  },
  flux: {
    MESSAGE_CREATE: (event: ClientEvent) => {
      capture?.observe({ ...event, type: "MESSAGE_CREATE" });
    },
    MESSAGE_UPDATE: (event: ClientEvent) => {
      capture?.observe({ ...event, type: "MESSAGE_UPDATE" });
    },
    MESSAGE_DELETE: (event: ClientEvent) => {
      capture?.observe({ ...event, type: "MESSAGE_DELETE" });
    },
    MESSAGE_DELETE_BULK: (event: ClientEvent) => {
      capture?.observe({ ...event, type: "MESSAGE_DELETE_BULK" });
    },
    CONNECTION_OPEN: () => {
      capture?.queue.connected(true);
    },
    CONNECTION_CLOSED: () => {
      capture?.queue.connected(false);
    },
    LOGOUT: () => pause(),
  },
});
