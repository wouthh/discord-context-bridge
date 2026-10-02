import {
  allowed,
  type Source,
  type Observation,
  type SourceHealth,
  sanitizeText,
  eventSchema,
} from "../../domain/src/index.js";
/** Memory-only bounded queue. A restart discards content and records an offline gap. */
export class DeliveryQueue {
  private events: Observation[] = [];
  private busy = false;
  private abort: AbortController | null = null;
  private epoch = 0;
  private failures = 0;
  private nextAttempt = 0;
  private health: SourceHealth;
  constructor(
    public source: Source,
    private max = 500,
    private ttlMs = 3600000,
    private now = Date.now,
  ) {
    this.health = {
      sourceId: source.id,
      accountId: source.accountId,
      generation: source.generation,
      connected: false,
      paused: true,
      lastObservedAt: null,
      gapSince: now(),
      overflow: 0,
      queueDepth: 0,
    };
  }
  configure(source: Source) {
    this.abort?.abort();
    this.epoch++;
    this.events = [];
    this.source = source;
    this.health = {
      ...this.health,
      sourceId: source.id,
      accountId: source.accountId,
      generation: source.generation,
      paused: true,
      connected: false,
      gapSince: this.now(),
      lastObservedAt: null,
      overflow: 0,
    };
  }
  pause(paused = true) {
    this.health.paused = paused;
    if (paused) {
      this.abort?.abort();
      this.epoch++;
      this.events = [];
      this.health.gapSince = this.now();
    }
  }
  purge() {
    this.pause();
  }
  connected(connected: boolean) {
    this.health.connected = connected;
    if (!connected) this.health.gapSince ??= this.now();
  }
  status() {
    this.expire();
    return { ...this.health, queueDepth: this.events.length };
  }
  capture(input: Observation) {
    this.expire();
    if (
      this.health.paused ||
      !allowed(
        this.source,
        input.accountId,
        input.conversationId,
        input.generation,
      ) ||
      input.sourceId !== this.source.id
    )
      return false;
    const event = eventSchema.parse(input);
    this.health.lastObservedAt = this.now();
    if (event.op === "upsert") event.text = sanitizeText(event.text);
    const old = this.events.find(
      (e) =>
        e.messageId === event.messageId &&
        e.conversationId === event.conversationId,
    );
    if (old?.op === "delete" && old.reason !== "unavailable_edit") return false;
    if (old && event.op !== "delete" && old.revision > event.revision)
      return false;
    this.events = this.events.filter((e) => e !== old);
    if (this.events.length >= this.max) {
      this.events.shift();
      this.health.overflow++;
      this.health.gapSince ??= this.now();
    }
    this.events.push(event);
    return true;
  }
  private expire() {
    const cutoff = this.now() - this.ttlMs;
    const kept = this.events.filter((e) => e.observedAt >= cutoff);
    if (kept.length !== this.events.length) {
      this.health.overflow += this.events.length - kept.length;
      this.health.gapSince ??= this.now();
    }
    this.events = kept;
  }
  async flush(
    send: (
      events: Observation[],
      health: SourceHealth,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {
    this.expire();
    if (this.busy || this.health.paused || this.now() < this.nextAttempt)
      return;
    this.busy = true;
    const epoch = this.epoch;
    const batch = this.events.slice(0, 100);
    this.abort = new AbortController();
    try {
      await send(batch, this.status(), this.abort.signal);
      if (epoch === this.epoch) {
        const ids = new Set(batch.map((e) => e.eventId));
        this.events = this.events.filter((e) => !ids.has(e.eventId));
        this.failures = 0;
        this.nextAttempt = 0;
      }
    } catch {
      if (epoch === this.epoch) {
        this.health.gapSince ??= this.now();
        this.failures++;
        this.nextAttempt =
          this.now() + Math.min(60000, 1000 * 2 ** Math.min(this.failures, 6));
      }
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }
}
