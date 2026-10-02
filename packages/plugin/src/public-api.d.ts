/** Packaging boundary for the bundled core. Implementation is checked in the workspace. */
export type Source = {
  id: string;
  type: "bot" | "personal";
  accountId: string;
  enabled: boolean;
  generation: number;
  conversations: { id: string; guildId?: string }[];
};
export type ClientMessage = {
  id?: string;
  channel_id?: string;
  content?: string;
  author?: { id?: string };
  timestamp?: string | number;
  edited_timestamp?: string | number | null;
};
export type ClientEvent = {
  type: string;
  message?: ClientMessage;
  channelId?: string;
  channel_id?: string;
  id?: string;
  ids?: string[];
};
export type Observation =
  | {
      eventId: string;
      sourceId: string;
      accountId: string;
      conversationId: string;
      generation: number;
      messageId: string;
      observedAt: number;
      revision: number;
      op: "delete";
      reason?: "unavailable_edit";
    }
  | {
      eventId: string;
      sourceId: string;
      accountId: string;
      conversationId: string;
      generation: number;
      messageId: string;
      observedAt: number;
      revision: number;
      op: "upsert";
      createdAt: number;
      authorId: string;
      text: string;
    };
export type Health = {
  sourceId: string;
  accountId: string;
  generation: number;
  connected: boolean;
  paused: boolean;
  lastObservedAt: number | null;
  gapSince: number | null;
  overflow: number;
  queueDepth: number;
};
export declare class PersonalCapture {
  readonly queue: {
    source: Source;
    purge(): void;
    connected(value: boolean): void;
    status(): Health;
  };
  constructor(
    source: Source,
    account: () => string | undefined,
    channelType: (id: string) => number | undefined,
    now?: () => number,
    max?: number,
    ttlMs?: number,
  );
  pause(): void;
  resume(): boolean;
  configure(source: Source): void;
  observe(event: ClientEvent): boolean;
  export(
    send: (
      events: Observation[],
      health: Health,
      signal: AbortSignal,
    ) => Promise<void>,
  ): Promise<void>;
}
export declare function connectorUrl(value: string): string;

export declare function sourceMatches(
  selected: Source,
  remote: Source,
  minimumGeneration?: number,
  conversationScopeComplete?: boolean,
): boolean;

export type ControlRetryPlan =
  | { state: "blocked" }
  | { state: "acknowledged" }
  | { state: "send"; generation: number };
export declare function planControlRetry(
  original: Source,
  action: "purge" | "revoke",
  conversationId: string | undefined,
  remote: Source | undefined,
  conversationScopeComplete?: boolean,
): ControlRetryPlan;

export type ControlBarrier = {
  version: 1;
  endpoint: string;
  original: Source;
  action: "purge" | "revoke";
  conversationId?: string;
  confirmed: boolean;
  minimumGeneration: number;
};
export declare function parseControlBarrier(
  value: string,
): ControlBarrier | null;
export declare function createControlBarrier(
  original: Source,
  action: "purge" | "revoke",
  endpoint: string,
  conversationId?: string,
): ControlBarrier;
export declare function confirmControlBarrier(
  barrier: ControlBarrier,
  generation: number,
): ControlBarrier;
export declare function controlBarrierMinimum(
  barrier: ControlBarrier | null,
  source: Source,
  endpoint: string,
): number;
