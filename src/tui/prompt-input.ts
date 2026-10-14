// Where what you type goes. Enter sends it: a prompt when the agent is idle, a steer when it is
// working (said to the model at its next step), a command when it starts with "/", your own shell
// when it starts with "!". Alt+Enter queues it for after the run. Images go in as [Image #N], from
// the clipboard or a file dropped on the terminal; queued messages can be taken back to edit.

import type { Agent } from "../loop.ts";
import type { Image } from "../types.ts";
import type { Editor } from "./editor.ts";
import { imageFromFile, imagePathOf } from "./images.ts";
import type { ImageRegistry } from "./images.ts";
import type { Marker } from "./marker.ts";
import type { ModelSwitch } from "./model-switch.ts";
import type { RunView } from "./run-view.ts";
import type { Scrollback } from "./scrollback.ts";

export interface PromptInputOptions {
  agent: () => Agent;
  editor: Editor;
  images: ImageRegistry;
  run: RunView;
  marker: Marker;
  scrollback: Scrollback;
  /** With no model yet, a prompt opens /models instead. */
  models: ModelSwitch;
  /** A slash command; false when there is none by that name. */
  command: (text: string) => Promise<boolean>;
  /** "!command": run in the user's own shell. */
  shell: (command: string) => Promise<void>;
  /** Reads the clipboard image (an Image, or why not). */
  clipboard: (signal: AbortSignal) => Promise<Image | string>;
  /** Where a pasted relative image path is read from. */
  cwd: string;
  render: () => void;
}

export class PromptInput {
  #opts: PromptInputOptions;

  constructor(opts: PromptInputOptions) {
    this.#opts = opts;
  }

  /** Enter: a prompt when idle, a steer when running; "/" a command, "!" the shell. */
  async submit(): Promise<void> {
    const { editor, marker, run, render } = this.#opts;
    const agent = this.#opts.agent();
    const text = editor.text.trim();
    if (text === "") return;
    if (text.startsWith("!")) {
      editor.remember(text);
      editor.clear();
      await this.#opts.shell(text.slice(1).trim());
      return;
    }
    if (text.startsWith("/")) {
      editor.clear();
      if (!(await this.#opts.command(text))) this.#opts.scrollback.print("system", `unknown command ${text}: try /help`);
      render();
      return;
    }
    // No model yet: what was typed stays, and /models opens to set one up.
    if (this.#opts.models.noModel) {
      this.#opts.models.open();
      render();
      return;
    }
    editor.remember(text);
    editor.clear();
    marker.clear();
    if (agent.state === "running") {
      // A steer: it shows in the queued area until it reaches the model ("delivered"), and only
      // then joins the transcript.
      agent.steer(text, this.#opts.images.attached(text));
      render();
      return;
    }
    run.started();
    run.echoUser(text);
    void this.#prompt(text);
  }

  /** Alt+Enter: a follow-up when running (it waits for the run to end), a plain prompt when idle. */
  followUp(): void {
    const { editor, marker, run, render } = this.#opts;
    const agent = this.#opts.agent();
    const text = editor.text.trim();
    if (text === "") return;
    editor.remember(text);
    editor.clear();
    run.started();
    marker.clear();
    if (agent.state === "running") {
      agent.followUp(text, this.#opts.images.attached(text));
      render();
      return;
    }
    run.echoUser(text);
    void this.#prompt(text);
  }

  /** Alt+Up takes the newest queued message back, Alt+C all of them: into the editor, before
   *  what is typed there. */
  takeBack(texts: string[]): void {
    if (texts.length === 0) return;
    const editor = this.#opts.editor;
    const current = editor.text.trim();
    const back = texts.join("\n");
    editor.setText(current === "" ? back : `${back}\n${current}`);
    this.#opts.render();
  }

  /** Ctrl+V: the clipboard image goes in at the cursor as [Image #N]. */
  async pasteImage(): Promise<void> {
    this.#addImage(await this.#opts.clipboard(AbortSignal.timeout(5_000)));
  }

  /**
   * A paste that is one image file's path (a file dropped on the terminal) attaches the file; an
   * empty paste (the terminal found no text: the clipboard holds an image) reads the clipboard.
   * False when the paste is plain text for the editor.
   */
  pastedImage(paste: string): boolean {
    if (paste.trim() === "") {
      void this.pasteImage();
      return true;
    }
    const path = imagePathOf(paste);
    if (path === undefined) return false;
    void imageFromFile(path, this.#opts.cwd).then((image) => {
      if (image === undefined) this.#opts.editor.insert(paste); // no such file: it was text after all
      else this.#addImage(image);
      this.#opts.render();
    });
    return true;
  }

  async #prompt(text: string): Promise<void> {
    await this.#opts.agent().prompt(text, this.#opts.images.attached(text));
    this.#opts.run.stopped();
    this.#opts.render();
  }

  #addImage(image: Image | string): void {
    if (typeof image === "string") this.#opts.marker.warn(`Image not attached: ${image}`);
    else this.#opts.editor.insert(`${this.#opts.images.add(image)} `);
    this.#opts.render();
  }
}
