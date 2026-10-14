// How each tile looks and what it says, from the floor's state: the run is here (active), it waits
// for you, it works on its own (busy), something went wrong. Pure, like the factory.

import type { Factory, Tone } from "./factory.ts";
import type { MachineId } from "./machines.ts";
import { TILE } from "./words.ts";

export interface Tile {
  tone: Tone;
  now: string;
  /** 0..1, drawn as a bar under the tile. */
  progress?: number;
}

export function tileOf(f: Factory, id: MachineId): Tile {
  const here = f.running && f.cursor === id;
  const tone = (quiet: Tone = "idle"): Tone => (here ? "active" : quiet);
  const call = f.worked;
  switch (id) {
    case "inbox": {
      const queued = f.queue.steer.length + f.queue.followUp.length;
      return { tone: tone(queued > 0 ? "waiting" : "idle"), now: queued > 0 ? TILE.queued(f.queue.steer.length, f.queue.followUp.length) : f.running ? TILE.idle : TILE.waitingForYou };
    }
    case "history":
      return { tone: tone(), now: TILE.messages(f.history.length) };
    case "compactor":
      return f.compaction
        ? { tone: "busy", now: TILE.summarising(f.compaction.done, f.compaction.total), ...(f.compaction.total ? { progress: f.compaction.done / f.compaction.total } : {}) }
        : { tone: tone(), now: f.compactions > 0 ? `${f.compactions}× so far` : TILE.idle };
    case "context":
      return { tone: tone(), now: f.request ? TILE.filtered(f.request.history, f.request.messages) : TILE.idle };
    case "press":
      return { tone: tone(), now: f.turn > 0 ? TILE.sentWith(f.turn) : TILE.idle };
    case "toolbox":
      return { tone: tone(), now: f.request ? TILE.tools(f.request.tools) : TILE.idle };
    case "request":
      if (f.retry && here) return { tone: "warn", now: TILE.retrying(f.retry.attempt, f.retry.of) };
      return { tone: tone(), now: f.request ? TILE.request(f.turn, f.request.tokens) : TILE.idle };
    case "prefill": {
      // While it reads: how far (llama.cpp tells). After: what the engine counted for the last reply.
      const p = f.prefill;
      if (here && p !== undefined) return { tone: "active", now: TILE.reading(p.done, p.total), progress: p.done / Math.max(p.total, 1) };
      if (f.usage !== undefined) return { tone: tone(), now: TILE.read(f.usage.input, f.usage.cacheRead ?? 0) };
      return { tone: tone(), now: p ? TILE.read(p.total, 0) : TILE.idle };
    }
    case "stream": {
      const r = f.reply;
      const now =
        r.pending.length > 0 && here
          ? TILE.writingCall(r.pending.at(-1) ?? "")
          : r.text
            ? (here ? TILE.writing : TILE.wrote)(r.text.length)
            : r.thinking
              ? (here ? TILE.thinking : TILE.thought)(r.thinking.length)
              : TILE.idle;
      return { tone: tone(), now };
    }
    case "guards": {
      const last = f.guards.at(-1);
      const fresh = last !== undefined && f.running && last.turn === f.turn;
      return { tone: here || fresh ? "warn" : "idle", now: last && fresh ? last.what.replace("_", " ") : TILE.quiet };
    }
    case "dispatcher":
      return { tone: tone(), now: f.dispatched ? TILE.calls(f.calls.length) : TILE.idle };
    case "gate": {
      const g = f.gates.at(-1);
      return { tone: here ? "active" : g?.decision === "block" && f.running ? "error" : "idle", now: g ? TILE.decision(g.skipped ? "pass" : g.decision, g.call.name) : TILE.idle };
    }
    case "approval":
      return f.approval ? { tone: "waiting", now: TILE.waitingForYou } : { tone: "idle", now: f.approvals.at(-1)?.by ? `${f.approvals.at(-1)?.allow ? "allowed" : "denied"} · ${f.approvals.at(-1)?.by}` : TILE.idle };
    case "workbench":
      if (call === undefined) return { tone: tone(), now: TILE.idle };
      if (call.status === "running") return { tone: tone("busy"), now: TILE.running(call.call.name) };
      if (call.status === "failed") return { tone: here ? "error" : "idle", now: TILE.failed(call.call.name) };
      return { tone: tone(), now: call.output !== undefined && call.status === "done" ? TILE.answered(call.call.name, call.output.length) : TILE.idle };
    case "jobs":
      return { tone: f.jobs > 0 ? "busy" : "idle", now: TILE.shells(f.jobs) };
    case "exit": {
      const end = f.ended;
      if (end === undefined) return { tone: "idle", now: f.running ? "" : TILE.idle };
      const quiet: Tone = end.reason === "done" ? "done" : end.reason === "error" ? "error" : "warn";
      return { tone: f.running ? "idle" : quiet, now: end.reason };
    }
  }
}
