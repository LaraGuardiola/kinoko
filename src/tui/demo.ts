// Manual demo for the TUI foundation: fake assistant text streams for 10 seconds while the editor
// keeps accepting keystrokes, exactly like a real run. Run it in a terminal:
//
//   bun run src/tui/demo.ts
//
// Esc quits. Enter submits the buffer (it is echoed as "queued"), Shift+Enter makes a new line.

import { Term } from "./term.ts";
import { Editor } from "./editor.ts";
import { Renderer, ansi } from "./render.ts";
import { renderMarkdown } from "./markdown.ts";

const DURATION_MS = 10_000;
const FRAME_MS = 33; // ~30fps

const SENTENCES = [
  "Reading the phase spec now.",
  "The interesting part is the state machine:",
  "",
  "- `delta.reasoning_content` becomes a thinking event",
  "- it never leaks into **text**",
  "",
  "```ts",
  'for (const key of parser.push(chunk)) render(key);',
  "```",
  "",
  "That is all of it.",
];

const term = new Term();
const editor = new Editor({ history: ["previous prompt"] });
const renderer = new Renderer({ write: (text) => term.write(text) });

let stream = "";
let line = 0;
let char = 0;
let running = true;
let submitted: string[] = [];
const startedAt = Date.now();

function streamStep(): void {
  const current = SENTENCES[line] ?? "";
  if (char >= current.length) {
    line = (line + 1) % SENTENCES.length;
    char = 0;
    stream = stream + "\n";
    return;
  }
  // A word at a time, so the region grows the way real streaming text does.
  const space = current.indexOf(" ", char);
  const end = space < 0 ? current.length : space + 1;
  stream += current.slice(char, end);
  char = end;
}

/** The live region: status line, streamed text, submitted messages, queued drafts, editor. */
function frame(): string[] {
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const lines: string[] = [`${ansi.dim}kinoko demo ${seconds}s — Esc quits${ansi.reset}`];
  if (stream !== "") lines.push(...renderMarkdown(stream.replace(/\n$/, "")).split("\n"));
  for (const text of submitted) lines.push(`${ansi.dim}> ${text}${ansi.reset}`);
  lines.push("");
  for (const text of editor.lines) lines.push(`> ${text}`);
  return lines;
}

function draw(): void {
  const view = editor.view(wrap60);
  const lines = frame();
  renderer.update({ lines: lines, row: lines.length - 1 + view.row, col: view.col + 2 });
  renderer.frame();
}

function wrap60(text: string): string[] {
  return text.length > 60 ? (text.match(/.{1,60}/g) ?? [text]) : [text];
}

term.on({
  key: (key) => {
    const action = editor.handle(key);
    switch (key.name) {
      case "escape":
      case "ctrl-c":
        if (editor.empty) running = false;
        else editor.clear();
        return;
      case "ctrl-d":
        if (editor.empty) running = false;
        return;
      default:
        break;
    }
    if (action === "submit") {
      const text = editor.text.trim();
      editor.remember(text);
      editor.clear();
      submitted.push(text);
      if (submitted.length > 3) submitted.shift();
      return;
    }
    renderer.frame();
  },
  resize: () => renderer.flush(),
});

term.start();
term.write(ansi.hide);

const timer = setInterval(() => {
  if (Date.now() - startedAt >= DURATION_MS) {
    clearInterval(timer);
    running = false;
  }
  streamStep();
  renderer.flush();
}, 120);

const loop = setInterval(() => {
  term.pollKeys(); // a lone Esc is held back for one frame
  draw();
}, FRAME_MS);

function finish(): void {
  clearInterval(timer);
  clearInterval(loop);
  term.stop();
  process.exit(0);
}

const watcher = setInterval(() => {
  if (!running) {
    clearInterval(watcher);
    finish();
  }
}, 50);