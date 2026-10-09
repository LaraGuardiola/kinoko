// The panel's state: what the App tells it (the terminal's size reports, the model's todo
// calls, a resumed history) and what it fetches itself (the working tree's changes, asynchronously,
// one git run at a time). panel.ts draws it.

import type { Message, ToolCall } from "../types.ts";
import { gitChanges } from "./changes.ts";
import type { FileChange, TreeState } from "./changes.ts";
import { maxScroll, panelRows, panelWidth, wideEnough } from "./panel.ts";
import { TODO_TOOL, latestTodos, todosOf } from "./todos.ts";
import type { Todo } from "./todos.ts";

export type ChangesSource = (signal: AbortSignal) => Promise<TreeState | undefined>;

export class SidePanel {
  #todos: Todo[] = [];
  #changes: FileChange[] | undefined = [];
  #head: string | undefined;
  #expanded = false; // Ctrl+O: the plan takes the column
  #scroll = 0; // the first task shown, unfolded
  #height = 0; // the column's height as last drawn: how far a scroll may go
  #window: number | undefined; // pixels, from the terminal's reports
  #screen: number | undefined;
  #source: ChangesSource;
  #onChange: () => void;
  #fetching = false;
  #again = false; // asked for while a fetch was running: run once more after it
  #fetched = false;

  constructor(cwd: string, onChange: () => void, source?: ChangesSource) {
    this.#source = source ?? ((signal) => gitChanges(cwd, signal));
    this.#onChange = onChange;
  }

  get todos(): Todo[] {
    return this.#todos;
  }

  get changes(): FileChange[] | undefined {
    return this.#changes;
  }

  /** The window's share of the screen, once the terminal said both; undefined until then. */
  get share(): number | undefined {
    return this.#window && this.#screen ? this.#window / this.#screen : undefined;
  }

  /** A size report from the terminal (see SIZE_QUERY). */
  size(report: { of: "window" | "screen"; width: number }): void {
    if (report.of === "window") this.#window = report.width;
    else this.#screen = report.width;
  }

  visible(cols: number | undefined): boolean {
    const on = cols !== undefined && wideEnough(cols, this.share);
    // The first time it shows, it needs the changes; after that each tool call refreshes them.
    if (on && !this.#fetched) this.refresh();
    return on;
  }

  /** A tool call the model made: a todo call is the new plan. */
  toolCall(call: ToolCall): void {
    if (call.name !== TODO_TOOL) return;
    const todos = todosOf(call.args);
    if (todos !== undefined) this.#todos = todos;
  }

  /** A resumed session: its plan is the last todo call in it. */
  history(messages: Message[]): void {
    this.#todos = latestTodos(messages);
  }

  /** Reads the changes again (after a tool ran, a run ended); a call during a read queues one more. */
  refresh(): void {
    this.#fetched = true;
    if (this.#fetching) {
      this.#again = true;
      return;
    }
    this.#fetching = true;
    void this.#source(AbortSignal.timeout(10_000))
      .then((tree) => {
        this.#changes = tree?.files;
        this.#head = tree?.head;
      })
      .catch(() => undefined)
      .finally(() => {
        this.#fetching = false;
        this.#onChange();
        if (this.#again) {
          this.#again = false;
          this.refresh();
        }
      });
  }

  get expanded(): boolean {
    return this.#expanded;
  }

  /** Ctrl+O: the plan unfolds over the column (from the task at hand), or folds back. */
  toggle(): void {
    this.#expanded = !this.#expanded;
    const first = this.#todos.findIndex((t) => t.status !== "done");
    this.#scroll = Math.max(0, (first < 0 ? this.#todos.length : first) - 1);
  }

  fold(): void {
    this.#expanded = false;
  }

  /** Scrolls the unfolded plan by whole tasks; "end" and "start" jump. */
  scroll(by: number | "start" | "end", width: number): void {
    const most = maxScroll(this.#todos, width, this.#height);
    const next = by === "start" ? 0 : by === "end" ? most : this.#scroll + by;
    this.#scroll = Math.max(0, Math.min(next, most));
  }

  /** The window changed size: its share of the screen is unknown until the terminal answers again. */
  resized(): void {
    this.#window = undefined;
  }

  /**
   * The column for a window `cols` wide, or undefined when it has no room: its width, its rows for
   * a height, and a key that changes when what it shows does.
   */
  column(cols: number | undefined): { width: number; rows: (height: number) => string[]; key: string } | undefined {
    if (cols === undefined || !this.visible(cols)) return undefined;
    const width = panelWidth(cols);
    const facts = { todos: this.#todos, changes: this.#changes, head: this.#head };
    const view = { expanded: this.#expanded, scroll: this.#scroll };
    const rows = (height: number): string[] => {
      this.#height = height;
      if (view.expanded) view.scroll = Math.min(view.scroll, maxScroll(this.#todos, width, height));
      return panelRows(facts, width, height, view);
    };
    return { width, rows, key: JSON.stringify([width, facts, view]) };
  }
}
