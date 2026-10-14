// The one-line note above the editor: what just happened, until something else does. Its tone
// says how it is drawn: a warning on an inverse band ("a run is going: Esc it first"), a note that
// only informs in cream ("copied: 3 lines"), an interruption in red.

export type MarkerTone = "warning" | "info" | "alert";

export class Marker {
  #text = "";
  #tone: MarkerTone = "warning";

  get text(): string {
    return this.#text;
  }

  get tone(): MarkerTone {
    return this.#tone;
  }

  /** Something the user should notice: it did not work, or not yet. */
  warn(text: string): void {
    this.#set(text, "warning");
  }

  /** Something that went as asked: a model picked, an extension installed. */
  inform(text: string): void {
    this.#set(text, "info");
  }

  /** The run was cut. */
  alert(text: string): void {
    this.#set(text, "alert");
  }

  clear(): void {
    this.#set("", "warning");
  }

  #set(text: string, tone: MarkerTone): void {
    this.#text = text;
    this.#tone = tone;
  }
}
