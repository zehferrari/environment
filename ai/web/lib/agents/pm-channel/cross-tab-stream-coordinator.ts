export type CrossTabStreamStateMessage<TState> = {
  state: TState;
  lastEventId: string;
};

type CrossTabMessage<TState> =
  | { type: "hello"; tabId: string; sentAt: number }
  | { type: "leader"; tabId: string; sentAt: number }
  | { type: "heartbeat"; tabId: string; sentAt: number }
  | { type: "state"; tabId: string; sentAt: number; state: TState; lastEventId: string }
  | { type: "closed"; tabId: string; sentAt: number };

type BroadcastLike<TState> = {
  postMessage(message: CrossTabMessage<TState>): void;
  close(): void;
  addEventListener(type: "message", listener: (event: MessageEvent<CrossTabMessage<TState>>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<CrossTabMessage<TState>>) => void): void;
};

export type CrossTabStreamCoordinatorOptions = {
  heartbeatMs?: number;
  staleLeaderMs?: number;
  claimJitterMs?: number;
  createBroadcastChannel?: (name: string) => BroadcastLike<any>;
  random?: () => number;
  now?: () => number;
};

export class CrossTabStreamCoordinator<TState> {
  readonly enabled: boolean;
  readonly tabId: string;

  private readonly channel: BroadcastLike<TState> | null;
  private readonly heartbeatMs: number;
  private readonly staleLeaderMs: number;
  private readonly claimJitterMs: number;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly roleListeners = new Set<(isLeader: boolean) => void>();
  private readonly stateListeners = new Set<(message: CrossTabStreamStateMessage<TState>) => void>();
  private readonly peerJoinListeners = new Set<() => void>();
  private leaderId: string | null = null;
  private lastLeaderSeenAt = 0;
  private leader = false;
  private closed = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private claimTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(name: string, options: CrossTabStreamCoordinatorOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? 1_000;
    this.staleLeaderMs = options.staleLeaderMs ?? 3_000;
    this.claimJitterMs = options.claimJitterMs ?? 120;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.tabId = makeTabId(this.random);

    const createBroadcastChannel = options.createBroadcastChannel ?? createNativeBroadcastChannel;
    this.channel = createBroadcastChannel ? tryCreateChannel<TState>(createBroadcastChannel, name) : null;
    this.enabled = this.channel !== null;

    if (!this.channel) return;

    this.channel.addEventListener("message", this.onMessage);
    this.post({ type: "hello", tabId: this.tabId, sentAt: this.now() });
    this.staleTimer = setInterval(() => this.checkLeader(), Math.max(250, Math.floor(this.heartbeatMs / 2)));
    this.scheduleClaim();
  }

  isLeader() {
    return !this.enabled || this.leader;
  }

  onRoleChange(listener: (isLeader: boolean) => void) {
    this.roleListeners.add(listener);
    listener(this.isLeader());
    return () => this.roleListeners.delete(listener);
  }

  onState(listener: (message: CrossTabStreamStateMessage<TState>) => void) {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onPeerJoin(listener: () => void) {
    this.peerJoinListeners.add(listener);
    return () => this.peerJoinListeners.delete(listener);
  }

  publishState(state: TState, lastEventId: string) {
    if (!this.channel || !this.leader || this.closed) return;
    this.post({ type: "state", tabId: this.tabId, sentAt: this.now(), state, lastEventId });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.post({ type: "closed", tabId: this.tabId, sentAt: this.now() });
    this.clearTimers();
    this.channel?.removeEventListener("message", this.onMessage);
    this.channel?.close();
  }

  private onMessage = (event: MessageEvent<CrossTabMessage<TState>>) => {
    const message = event.data;
    if (!message || message.tabId === this.tabId || this.closed) return;

    if (message.type === "hello") {
      if (this.leader) {
        this.post({ type: "leader", tabId: this.tabId, sentAt: this.now() });
        this.peerJoinListeners.forEach((listener) => listener());
      }
      return;
    }

    if (message.type === "closed") {
      if (this.leaderId === message.tabId) {
        this.leaderId = null;
        this.lastLeaderSeenAt = 0;
        this.scheduleClaim();
      }
      return;
    }

    if (message.type === "leader" || message.type === "heartbeat") {
      this.observeLeader(message.tabId, message.sentAt);
      return;
    }

    if (message.type === "state") {
      this.observeLeader(message.tabId, message.sentAt);
      if (!this.leader) {
        this.stateListeners.forEach((listener) => listener({ state: message.state, lastEventId: message.lastEventId }));
      }
    }
  };

  private observeLeader(nextLeaderId: string, seenAt: number) {
    const shouldReplaceLeader =
      !this.leaderId
      || this.leaderId === nextLeaderId
      || (this.leader && nextLeaderId < this.tabId)
      || (!this.leader && this.isLeaderStale());

    if (!shouldReplaceLeader) return;

    this.leaderId = nextLeaderId;
    this.lastLeaderSeenAt = seenAt || this.now();
    if (nextLeaderId !== this.tabId) {
      this.becomeFollower();
    }
  }

  private checkLeader() {
    if (this.closed || this.leader) return;
    if (!this.leaderId || this.isLeaderStale()) {
      this.scheduleClaim();
    }
  }

  private scheduleClaim() {
    if (this.closed || this.leader || this.claimTimer) return;
    this.claimTimer = setTimeout(() => {
      this.claimTimer = null;
      if (this.closed || this.leader) return;
      if (this.leaderId && !this.isLeaderStale()) return;
      this.becomeLeader();
    }, Math.floor(this.random() * this.claimJitterMs));
  }

  private becomeLeader() {
    if (this.closed || this.leader) return;
    this.leader = true;
    this.leaderId = this.tabId;
    this.lastLeaderSeenAt = this.now();
    if (this.claimTimer) {
      clearTimeout(this.claimTimer);
      this.claimTimer = null;
    }
    this.post({ type: "leader", tabId: this.tabId, sentAt: this.lastLeaderSeenAt });
    this.heartbeatTimer = setInterval(() => {
      this.post({ type: "heartbeat", tabId: this.tabId, sentAt: this.now() });
    }, this.heartbeatMs);
    this.roleListeners.forEach((listener) => listener(true));
  }

  private becomeFollower() {
    if (!this.leader) return;
    this.leader = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.roleListeners.forEach((listener) => listener(false));
  }

  private isLeaderStale() {
    return this.now() - this.lastLeaderSeenAt > this.staleLeaderMs;
  }

  private post(message: CrossTabMessage<TState>) {
    try {
      this.channel?.postMessage(message);
    } catch {
      // BroadcastChannel can throw during page teardown; local streaming should continue.
    }
  }

  private clearTimers() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.claimTimer) clearTimeout(this.claimTimer);
    this.heartbeatTimer = null;
    this.staleTimer = null;
    this.claimTimer = null;
  }
}

function createNativeBroadcastChannel(name: string): BroadcastLike<any> | null {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) return null;
  return new BroadcastChannel(name);
}

function tryCreateChannel<TState>(createBroadcastChannel: (name: string) => BroadcastLike<TState> | null, name: string) {
  try {
    return createBroadcastChannel(name);
  } catch {
    return null;
  }
}

function makeTabId(random: () => number) {
  return `${Date.now().toString(36)}-${Math.floor(random() * Number.MAX_SAFE_INTEGER).toString(36)}`;
}
