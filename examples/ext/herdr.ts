// Tells herdr that this pane runs an agent, and whether it works. Copy to ~/.kinoko/ext/ to enable.
//
// herdr (a terminal workspace for coding agents) lists a pane as an agent only when the agent says
// so. Listed, kinoko gets what herdr's other agents get: its status in the sidebar, and in Flux on
// a phone an agent screen with Live, where herdr resizes the pane to the phone's grid (and again
// after a rotation) so kinoko draws for the phone instead of being re-wrapped at its width. herdr
// forgets the agent by itself when kinoko exits. Outside herdr, or in print and rpc modes (no
// screen to show), this does nothing.

import { connect } from "node:net";
import type { Kinoko } from "../../src/ext.ts";

type State = "idle" | "working";

/** One request on herdr's socket (a JSON line); true once herdr answered. Never throws. */
export function send(socket: string, request: object, timeoutMs = 1000): Promise<boolean> {
  return new Promise((done) => {
    const conn = connect(socket);
    const finish = (ok: boolean): void => {
      clearTimeout(timer);
      conn.destroy();
      done(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    conn.on("connect", () => conn.write(`${JSON.stringify(request)}\n`));
    conn.on("data", () => finish(true));
    conn.on("error", () => finish(false));
    conn.on("end", () => finish(false));
  });
}

export default function (k: Kinoko, env: Record<string, string | undefined> = process.env): void {
  const socket = env.HERDR_SOCKET_PATH;
  const pane = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !socket || !pane) return;

  let on = false; // the TUI started: there is a screen herdr can show
  let last: State | undefined;
  let seq = Date.now() * 1000; // herdr drops a report older than the last one it took
  let queue = Promise.resolve();

  const report = (state: State): void => {
    if (!on || state === last) return;
    last = state;
    seq++;
    const params = { pane_id: pane, source: "kinoko", agent: "kinoko", state, seq };
    // In order: a quick idle must not overtake the working it ends.
    queue = queue.then(async () => {
      await send(socket, { id: `kinoko:${seq}`, method: "pane.report_agent", params });
    });
  };

  k.on("session_start", (info) => {
    on = info.mode === "tui";
    report("idle");
  });
  k.on("before_provider_request", () => report("working"));
  k.on("run_end", () => report("idle"));
}
