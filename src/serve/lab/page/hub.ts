// The page's line to `kinoko serve`: paired like any device (a one-time code in the link's
// fragment, traded for a token kept in this browser), then one WebSocket speaking docs/protocol.md.
// A dropped connection comes back by itself; what it missed comes again with the next attach.

const TOKEN_KEY = "kinoko-lab-token";

export type HubMessage = { type: string; id?: string; [key: string]: unknown };

function stored(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined; // storage blocked: pair again next time
  }
}

function store(token: string | undefined): void {
  try {
    if (token === undefined) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage blocked: this visit still works
  }
}

/** Signed in (the token), or why not: no link was followed, or its code was refused (used, expired). */
export type SignIn = { token: string } | { refused?: string };

/** The token this page talks with: the one kept here, or a new one for the code in the link. */
export async function signIn(): Promise<SignIn> {
  // `?c=` (a link from `kinoko serve lab`); `#c=` from an older one.
  const code = new URLSearchParams(location.search).get("c") ?? new URLSearchParams(location.hash.slice(1)).get("c");
  let refused: string | undefined;
  if (code) {
    history.replaceState(null, "", location.pathname); // the code works once: out of sight
    const answer = await fetch("/v1/pair", { method: "POST", body: JSON.stringify({ code, name: "Kinoko Lab (browser)" }) });
    if (answer.ok) {
      const { token } = (await answer.json()) as { token: string };
      store(token);
      return { token };
    }
    refused = answer.status === 429 ? "Too many tries: wait a minute." : "This link was already used, or it expired (they last ten minutes).";
  }
  const token = stored();
  if (token !== undefined) {
    const check = await fetch("/v1/agents", { headers: { authorization: `Bearer ${token}` } });
    if (check.status !== 401) return { token };
    store(undefined); // revoked, or this hub never knew it
  }
  return refused ? { refused } : {};
}

export class Hub {
  #token: string;
  #socket: WebSocket | undefined;
  #onMessage: (msg: HubMessage) => void;
  #onState: (connected: boolean) => void;
  #waiting = new Map<string, (msg: HubMessage) => void>();
  #seq = 0;
  #backoff = 500;

  constructor(token: string, handlers: { message: (msg: HubMessage) => void; state: (connected: boolean) => void }) {
    this.#token = token;
    this.#onMessage = handlers.message;
    this.#onState = handlers.state;
    this.#open();
  }

  #open(): void {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/v1/ws?token=${encodeURIComponent(this.#token)}`);
    this.#socket = socket;
    socket.addEventListener("open", () => {
      this.#backoff = 500;
      this.#onState(true);
    });
    socket.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data)) as HubMessage;
      const answer = msg.id === undefined ? undefined : this.#waiting.get(msg.id);
      if (answer !== undefined && msg.id !== undefined) {
        this.#waiting.delete(msg.id);
        answer(msg);
      }
      this.#onMessage(msg);
    });
    socket.addEventListener("close", () => {
      this.#onState(false);
      for (const answer of this.#waiting.values()) answer({ type: "error", detail: "the connection dropped" });
      this.#waiting.clear();
      setTimeout(() => this.#open(), this.#backoff);
      this.#backoff = Math.min(this.#backoff * 2, 10_000);
    });
  }

  /** Sends a message; its answer (the reply carrying the same id) when it comes. */
  ask(msg: object): Promise<HubMessage> {
    const id = `lab${++this.#seq}`;
    return new Promise((resolve) => {
      if (this.#socket?.readyState !== WebSocket.OPEN) return resolve({ type: "error", detail: "not connected" });
      this.#waiting.set(id, resolve);
      this.#socket.send(JSON.stringify({ ...msg, id }));
    });
  }

  /** Sends a message, not waiting for its answer. */
  tell(msg: object): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(msg));
  }
}
