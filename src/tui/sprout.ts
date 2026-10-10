// While the history is being compacted: mushrooms sprouting one by one, then going one by one,
// and the note saying how far the summary is. Pure: the frame comes from the clock.

import type { CompactProgress } from "../compact.ts";

const SLOTS = 5;
const STEP_MS = 280;
const MUSHROOM = "🍄";

/** The row of mushrooms at `now`: they sprout left to right, then go left to right, and again. */
export function sprouts(now: number): string {
  const step = Math.floor(now / STEP_MS) % (SLOTS * 2);
  return Array.from({ length: SLOTS }, (_, i) => {
    const shown = step < SLOTS ? i <= step : i > step - SLOTS;
    return shown ? MUSHROOM : "  "; // a mushroom is two columns wide: an empty slot keeps the row still
  }).join("");
}

function n(x: number): string {
  return x.toLocaleString("en-US");
}

/** "compacting… reading 12,400 / 28,100 tokens" or "compacting… writing the summary · 412 tokens". */
export function compactingNote(progress: CompactProgress, now: number): string {
  const what =
    progress.phase === "writing"
      ? `writing the summary · ${n(progress.done)} tokens`
      : progress.done > 0 && progress.total
        ? `reading ${n(progress.done)} / ${n(progress.total)} tokens`
        : `reading ${progress.total ? `~${n(progress.total)} ` : ""}tokens`;
  return `${sprouts(now)}  compacting… ${what}`;
}
