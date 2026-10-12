// Background jobs in the TUI: the label on the rule above the input ("⚙ 2 shells", a click opens
// the list), the list (/jobs: Enter opens a job's window, Del twice stops it), and the window: a
// framed view of the job's last lines, redrawn as it writes.

import { elapsed } from "../jobs.ts";
import type { Job, Jobs } from "../jobs.ts";
import type { InfoPage, ListPage, MenuPage } from "./menu.ts";
import { ANSI, visibleLength } from "./style.ts";
import { wrapAnsi } from "./view.ts";
import { userHome } from "../home.ts";

/** A job that ended well: the green of the tool bands. */
const GREEN = "\x1b[38;2;166;209;137m";

/** The rule's label while jobs run, or undefined. */
export function jobsLabel(running: number): string | undefined {
  return running === 0 ? undefined : `⚙ ${running} shell${running === 1 ? "" : "s"}`;
}

function stateText(job: Job, now: number): string {
  const took = elapsed((job.ended ?? now) - job.started);
  if (job.state === "running") return `running ${took}`;
  if (job.state === "done") return `done in ${took}`;
  if (job.state === "killed") return `stopped after ${took}`;
  return `failed (exit ${job.code ?? "?"}) after ${took}`;
}

export interface JobsHost {
  jobs: Jobs;
  open: (page: MenuPage) => void;
  swap: (from: MenuPage, to: MenuPage) => void;
  note: (text: string) => void;
  /** Columns and rows the window may take. */
  size: () => { cols: number; rows: number };
}

/** The list: newest first, running ones marked; Enter opens one's window, Del twice stops it. */
export function openJobs(host: JobsHost): void {
  let page = listPage(host);
  // Redrawn once a second while it is open (a job ends, the clocks move).
  const timer = setInterval(() => {
    const next = listPage(host);
    host.swap(page, next);
    page = next;
  }, 1000);
  timer.unref?.();
  page.leave = () => clearInterval(timer);
  host.open(page);
}

function listPage(host: JobsHost): ListPage {
  const now = Date.now();
  const all = host.jobs.list().toReversed();
  return {
    kind: "list",
    title: "Background jobs",
    items: all.map((job) => ({
      name: `#${job.id}`,
      key: `job-${job.id}`,
      description: `${stateText(job, now)} · ${job.command}`,
      current: job.state === "running",
      removable: job.state === "running",
    })),
    empty: "No background jobs yet: the model starts one with bash background: true",
    stay: true,
    hint: "Enter opens its window · Del twice stops it",
    pick: (item) => {
      const job = all.find((j) => `#${j.id}` === item.name);
      if (job) openWindow(host, job.id);
    },
    remove: (item) => {
      const job = all.find((j) => `#${j.id}` === item.name);
      if (job && host.jobs.kill(job.id)) host.note(`job #${job.id} stopped`);
    },
  };
}

/** A job's window: its last lines in a frame, redrawn as it writes; Enter back to the list. */
function openWindow(host: JobsHost, id: number): void {
  let page = windowPage(host, id);
  let queued = false;
  const redraw = (): void => {
    queued = false;
    const next = windowPage(host, id);
    host.swap(page, next);
    page = next;
  };
  // Output can come fast: at most one redraw per 100 ms; and once a second for the clock.
  const stop = host.jobs.on(() => {
    if (queued) return;
    queued = true;
    setTimeout(redraw, 100).unref?.();
  });
  const timer = setInterval(redraw, 1000);
  timer.unref?.();
  page.leave = () => {
    stop();
    clearInterval(timer);
  };
  host.open(page);
}

function windowPage(host: JobsHost, id: number): InfoPage {
  const job = host.jobs.list().find((j) => j.id === id);
  const { cols, rows } = host.size();
  const width = Math.max(20, cols - 2); // the frame's own columns
  const inner = width - 4;
  const height = Math.max(3, rows);
  if (job === undefined) return { kind: "info", title: "Background job", lines: ["  it is gone"] };
  const text = host.jobs.tail(id, height * 2).flatMap((line) => wrapAnsi(line === "" ? " " : line, inner)).slice(-height);
  const body = text.length > 0 ? text : [`${ANSI.dim}(nothing written yet)${ANSI.reset}`];
  const color = job.state === "running" ? ANSI.cream : job.state === "done" ? GREEN : ANSI.amanita;
  const head = ` #${job.id} · ${stateText(job, Date.now())} `;
  const foot = ` ${job.log.replace(userHome(), "~")} `;
  const line = (label: string, left: string, right: string): string => {
    const cut = visibleLength(label) > width - 4 ? `${label.slice(0, width - 5)}…` : label;
    return `${ANSI.dim}${left}─${ANSI.reset}${color}${cut}${ANSI.reset}${ANSI.dim}${"─".repeat(Math.max(0, width - 3 - visibleLength(cut)))}${right}${ANSI.reset}`;
  };
  return {
    kind: "info",
    title: `$ ${job.command.length > width - 4 ? `${job.command.slice(0, width - 5)}…` : job.command}`,
    lines: [
      line(head, "╭", "╮"),
      ...body.map((row) => `${ANSI.dim}│${ANSI.reset} ${row}${" ".repeat(Math.max(0, inner - visibleLength(row)))} ${ANSI.dim}│${ANSI.reset}`),
      line(foot, "╰", "╯"),
    ],
    hint: "Enter back to the jobs · Esc closes",
    next: () => openJobs(host),
  };
}
