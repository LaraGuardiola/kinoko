// Which key means what, given only two facts about the app. Pure, so the binding table is
// testable on its own and the App stays about state.

import type { Key } from "./term.ts";

export type KeyAction =
  | "abort" // Esc while running
  | "quit" // Ctrl-D on an empty editor, or Ctrl-C with nothing to clear
  | "clear-editor" // Ctrl-C with text in the editor
  | "pull-queued" // Alt+Up
  | "toggle-tools" // Ctrl-T
  | "submit" // Enter
  | "follow-up" // Alt+Enter while running
  | "editor" // everything the editor handles
  | "none";

export interface KeyContext {
  running: boolean;
  editorEmpty: boolean;
}

/**
 * docs/interruption.md is the spec:
 *   Enter          prompt when idle, steer when running
 *   Alt+Enter      follow-up when running, prompt when idle
 *   Esc            abort while running, nothing while idle
 *   Ctrl-C         abort / clear the editor / quit on a second press
 *   Alt+Up         pull the last queued message back
 */
export function actionFor(key: Key, ctx: KeyContext): KeyAction {
  switch (key.name) {
    case "escape":
      return ctx.running ? "abort" : "none";
    case "ctrl-c":
      if (ctx.running) return "abort";
      return ctx.editorEmpty ? "quit" : "clear-editor";
    case "ctrl-d":
      return ctx.editorEmpty ? "quit" : "none";
    case "ctrl-t":
      return "toggle-tools";
    case "shift-enter":
      return ctx.running ? "follow-up" : "submit";
    case "up":
      return key.alt === true ? "pull-queued" : "editor";
    default:
      return "editor";
  }
}