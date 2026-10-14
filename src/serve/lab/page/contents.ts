// What each machine holds, for its drawer: the run's state as the factory keeps it, and what was
// asked of the agent (the system prompt, the tools, the exact request) once the reader asks.

import type { Entry, Factory } from "../factory.ts";
import type { MachineId } from "../machines.ts";
import { promptParts } from "../prompt-parts.ts";
import { tileOf } from "../tiles.ts";
import { short } from "../words.ts";
import { facts, fold, h, pre, section } from "./dom.ts";
import type { Fetched, Inspectable } from "./drawer.ts";

interface Asked {
  fetched: Map<Inspectable, Fetched>;
  fetcher: (what: Inspectable, label: string) => HTMLElement;
}

const n = (x: number): string => x.toLocaleString("en-US");
const json = (value: unknown): string => JSON.stringify(value, null, 2);
const tokens = (text: string): string => `${n(text.length)} chars · ~${short(Math.ceil(text.length / 4))} tokens`;
const SHOWN = 200_000; // characters drawn at most in one block: a huge request stays readable

const clip = (text: string): string => (text.length <= SHOWN ? text : `${text.slice(0, SHOWN)}\n\n… ${n(text.length - SHOWN)} more characters`);
const empty = (text: string): HTMLElement => h("p.empty", {}, text);

/** What was asked of the agent: the button, or the answer (or why there is none). */
function asked(what: Inspectable, label: string, a: Asked, show: (data: unknown) => HTMLElement[]): HTMLElement[] {
  const got = a.fetched.get(what);
  const button = a.fetcher(what, label);
  if (got?.error) return [button, h("p.error", {}, got.error)];
  if (got?.data === undefined) return [button];
  return [button, ...show(got.data)];
}

function entry(e: Entry, i: number): HTMLElement {
  const kind = e.kind && e.kind !== "reply" && e.kind !== "result" && e.kind !== "prompt" ? ` · ${e.kind.replace("_", "-")}` : "";
  const calls = e.toolCalls?.map((c) => c.name).join(", ");
  const first = e.content.split("\n").find((l) => l.trim() !== "") ?? (calls ? `calls ${calls}` : "(empty)");
  const body = h(
    "div",
    {},
    e.thinking ? fold(`h${i}t`, `thinking · ${tokens(e.thinking)}`, pre(clip(e.thinking), "dim")) : undefined,
    pre(clip(e.content) || "(no text)"),
    e.toolCalls ? pre(json(e.toolCalls.map((c) => ({ name: c.name, args: c.args })))) : undefined,
  );
  return fold(`h${i}`, `${e.role}${kind} · ${first.slice(0, 70)}`, body);
}

export function contents(id: MachineId, f: Factory, a: Asked): Array<HTMLElement | undefined> {
  const now = section("Now", h("p.now", {}, tileOf(f, id).now || "—"));
  switch (id) {
    case "inbox": {
      const queued = [...f.queue.steer.map((t) => `steer: ${t}`), ...f.queue.followUp.map((t) => `follow-up: ${t}`)];
      const lastUser = f.history.findLast((e) => e.role === "user" && (e.kind === "prompt" || e.kind === undefined));
      return [now, section("Waiting to be said", ...(queued.length ? queued.map((q) => pre(q)) : [empty("Nothing queued. Type while it runs: Enter steers, Alt+Enter queues a follow-up.")])), section("Your last prompt", lastUser ? pre(lastUser.content) : empty("None yet."))];
    }
    case "history": {
      const shown = f.history.slice(-80);
      const skipped = f.history.length - shown.length;
      return [now, section(`${n(f.history.length)} messages, oldest first`, skipped > 0 ? empty(`(${n(skipped)} older ones not shown)`) : undefined, ...shown.map((e, i) => entry(e, i + skipped)))];
    }
    case "compactor":
      return [now, facts([["Compactions so far", n(f.compactions)], ["In progress", f.compaction ? `${f.compaction.done}/${f.compaction.total ?? "?"}` : "no"]]), empty("It runs before a request that would not fit the window, or when the endpoint says the prompt was too long.")];
    case "context":
      return [now, f.request ? facts([["Messages in the history", n(f.request.history)], ["Messages sent", n(f.request.messages)]]) : empty("Nothing sent yet."), empty("A `context` handler in an extension may return a different list: kinoko sends whatever comes out.")];
    case "press":
      return [
        now,
        section(
          "The system prompt",
          ...asked("system", "Show the system prompt", a, (data) => {
            const text = String(data);
            return [h("p", {}, tokens(text)), ...promptParts(text).map((p, i) => fold(`p${i}`, `${p.label} · ${tokens(p.text.trim())}`, pre(p.text.trim()), i === 0))];
          }),
        ),
      ];
    case "toolbox":
      return [
        now,
        section(
          "What the model can call",
          ...asked("tools", "Show the tools' schemas", a, (data) => {
            const tools = data as Array<{ name: string; description: string; schema: unknown }>;
            return tools.map((t) => fold(`t-${t.name}`, `${t.name} · ${tokens(json(t))}`, h("div", {}, h("p", {}, t.description), pre(json(t.schema)))));
          }),
        ),
      ];
    case "request":
      return [
        now,
        f.request
          ? facts([["Request", `#${f.turn} of this run`], ["Model", f.request.model], ["Messages", n(f.request.messages)], ["Tools", n(f.request.tools)], ["Characters", n(f.request.chars)], ["Tokens (estimate)", `~${n(f.request.tokens)}`]])
          : empty("Nothing sent yet."),
        f.retry ? h("p.warn", {}, `Retry ${f.retry.attempt}/${f.retry.of}: ${f.retry.error}`) : undefined,
        section("Exactly what was sent", ...asked("request", "Show the request (JSON)", a, (data) => [pre(clip(json(data)))])),
      ];
    case "prefill": {
      const u = f.usage;
      const cached = u?.cacheRead ?? 0;
      return [
        now,
        u ? facts([["Prompt tokens (the engine's count)", n(u.input)], ["Read from the cache", `${n(cached)} (${Math.round((cached / Math.max(u.input, 1)) * 100)}%)`], ["Written by the model", n(u.output)]]) : empty("No reply counted yet."),
        empty("The cache works while the start of the prompt stays the same: that is why kinoko never changes the system prompt mid-session, and adds notes at the end instead."),
      ];
    }
    case "stream": {
      const r = f.reply;
      return [now, section("Thinking", r.thinking ? pre(clip(r.thinking), "dim") : empty("None.")), section("Text", r.text ? pre(clip(r.text)) : empty("None.")), r.pending.length ? section("Calls being written", pre(r.pending.join(", "))) : undefined];
    }
    case "guards":
      return [now, section("What they noticed", ...(f.guards.length ? f.guards.toReversed().map((g) => pre(`request #${g.turn} · ${g.what.replace("_", " ")}: ${g.detail}`)) : [empty("Nothing yet: the model has behaved.")]))];
    case "dispatcher":
      return [now, section("The calls of the last reply, in order", ...(f.calls.length ? f.calls.map((c, i) => fold(`d${i}`, `${i + 1}. ${c.call.name} · ${c.status}`, pre(json(c.call.args)), true)) : [empty("No calls.")]))];
    case "gate":
      return [now, section("Decisions, newest first", ...(f.gates.length ? f.gates.toReversed().map((g) => pre(`${g.call.name}: ${g.skipped ? `ask, skipped (${g.skipped})` : g.decision}${g.by ? ` · by ${g.by}` : ""}${g.rewritten ? " · args rewritten" : ""}${g.reason ? `\n${g.reason}` : ""}`)) : [empty("No calls yet.")]))];
    case "approval":
      return [
        now,
        f.approval ? section("Waiting for you", pre(`${f.approval.call.name} ${json(f.approval.call.args)}\n\n${f.approval.reason}`), empty("Answer it in the terminal, the phone or Telegram.")) : undefined,
        section("Asked before", ...(f.approvals.length ? f.approvals.toReversed().map((x) => pre(`${x.call.name}: ${x.allow === undefined ? "waiting" : x.allow ? "allowed" : "denied"}${x.by ? ` (${x.by})` : ""}\n${x.reason}`)) : [empty("Nothing asked yet.")])),
      ];
    case "workbench": {
      const w = f.worked;
      return [now, w ? section(`${w.call.name} · ${w.status}`, h("h4", {}, "Arguments"), pre(json(w.call.args)), h("h4", {}, "Output"), w.output !== undefined ? pre(clip(w.output)) : empty("Running…")) : empty("Nothing has run yet.")];
    }
    case "jobs":
      return [now, empty("The terminal's /jobs page and the phone show each shell and can stop it.")];
    case "exit":
      return [
        now,
        f.ended ? facts([["Ended", f.ended.reason], ...(f.ended.detail ? ([["Why", f.ended.detail]] as Array<[string, string]>) : [])]) : empty(f.running ? "Still running." : "No run yet."),
        facts([["Requests (this page)", n(f.totals.requests)], ["Prompt tokens", n(f.totals.input)], ["Cached", n(f.totals.cached)], ["Written", n(f.totals.output)]]),
      ];
  }
}
