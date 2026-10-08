// A tool call's arguments while they stream: which string fields are already complete. Lets the
// UI show a write's path or a command as soon as the model has written it, long before the whole
// call (a large file can take minutes). Nothing here is ever used to run the call.

/** A complete `"key": "string value"` pair: the closing quote has arrived. */
const PAIR = /"([A-Za-z_]\w*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

export class ArgsWatcher {
  #text = "";
  #from = 0; // everything before this offset was already scanned into `fields`
  #fields: Record<string, string> = {};

  /**
   * Adds a piece of the JSON arguments. Returns every complete string field so far when this piece
   * completed a new one, undefined otherwise. Only a piece with a quote can close a string, so the
   * rest are free.
   */
  push(piece: string): Record<string, string> | undefined {
    this.#text += piece;
    if (!piece.includes('"')) return undefined;
    PAIR.lastIndex = this.#from;
    let found = false;
    for (let m = PAIR.exec(this.#text); m !== null; m = PAIR.exec(this.#text)) {
      const value = unescape(m[2] ?? "");
      if (value !== undefined && m[1] !== undefined && !(m[1] in this.#fields)) {
        this.#fields[m[1]] = value;
        found = true;
      }
      this.#from = PAIR.lastIndex;
    }
    return found ? { ...this.#fields } : undefined;
  }
}

function unescape(raw: string): string | undefined {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return undefined;
  }
}
