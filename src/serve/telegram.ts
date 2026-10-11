// Telegram's Bot API, the little kinoko uses: plain fetch to https://api.telegram.org/bot<token>/<method>,
// every call with an AbortSignal. Long polling (getUpdates), no webhook: no public URL needed.
// The token never appears in an error or a log: it is cut out of anything that is thrown.

export interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
  /** When it was sent, epoch seconds. */
  date?: number;
  reply_to_message?: TgMessage;
  /** The text that goes with a file. */
  caption?: string;
  /** A photo, in several sizes (the largest last). */
  photo?: TgFile[];
  document?: TgFile;
  video?: TgFile;
  audio?: TgFile;
  voice?: TgFile;
}

export interface TgFile {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgCallback {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}

/** Inline buttons: rows of {text, callback_data}. */
export type TgButtons = Array<Array<{ text: string; callback_data: string }>>;

/** A refusal from Telegram (bad token: 401), or no answer at all (`status` 0). */
export class TelegramError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const API_BASE = "https://api.telegram.org";

export class Telegram {
  #token: string;
  #base: string;

  constructor(token: string, base = API_BASE) {
    this.#token = token;
    this.#base = base;
  }

  async #call<T>(method: string, body: object, signal: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.#base}/bot${this.#token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new TelegramError(this.#clean(`could not reach Telegram: ${e instanceof Error ? e.message : String(e)}`), 0);
    }
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!res.ok || data.ok !== true) throw new TelegramError(this.#clean(data.description ?? `HTTP ${res.status}`), res.status);
    return data.result as T;
  }

  /** Whatever is thrown, without the token in it. */
  #clean(text: string): string {
    return this.#token === "" ? text : text.split(this.#token).join("<token>");
  }

  getMe(signal: AbortSignal): Promise<TgUser> {
    return this.#call("getMe", {}, signal);
  }

  /** Waits up to `timeout` seconds for updates after `offset` (long polling). */
  getUpdates(offset: number | undefined, timeout: number, signal: AbortSignal): Promise<TgUpdate[]> {
    return this.#call("getUpdates", { ...(offset === undefined ? {} : { offset }), timeout, allowed_updates: ["message", "callback_query"] }, signal);
  }

  sendMessage(chat: number, text: string, signal: AbortSignal, opts: { buttons?: TgButtons; replyTo?: number } = {}): Promise<TgMessage> {
    return this.#call(
      "sendMessage",
      {
        chat_id: chat,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(opts.buttons ? { reply_markup: { inline_keyboard: opts.buttons } } : {}),
        ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}),
      },
      signal,
    );
  }

  editMessageText(chat: number, message: number, text: string, signal: AbortSignal, buttons?: TgButtons): Promise<unknown> {
    return this.#call("editMessageText", { chat_id: chat, message_id: message, text, parse_mode: "HTML", ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) }, signal);
  }

  answerCallbackQuery(id: string, signal: AbortSignal, text?: string): Promise<unknown> {
    return this.#call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) }, signal);
  }

  /** Where a file sent to the bot can be downloaded from (bots may download up to 20 MB). */
  async getFile(id: string, signal: AbortSignal): Promise<string> {
    const file = await this.#call<{ file_path?: string }>("getFile", { file_id: id }, signal);
    if (!file.file_path) throw new TelegramError("Telegram gave no path for the file", 0);
    return file.file_path;
  }

  /** The bytes of a file from getFile. */
  async download(path: string, signal: AbortSignal): Promise<Uint8Array> {
    const res = await fetch(`${this.#base}/file/bot${this.#token}/${path}`, { signal }).catch((e: unknown) => {
      if (signal.aborted) throw e;
      throw new TelegramError(this.#clean(`could not reach Telegram: ${e instanceof Error ? e.message : String(e)}`), 0);
    });
    if (!res.ok) throw new TelegramError(`the download failed (HTTP ${res.status})`, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }

  setMyCommands(commands: Array<{ command: string; description: string }>, signal: AbortSignal): Promise<unknown> {
    return this.#call("setMyCommands", { commands }, signal);
  }
}

/** Text for HTML parse mode: & < > escaped. */
export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Telegram takes 4096 characters a message: a longer text is cut, with a tail saying where the rest is. */
export function capMessage(text: string, max = 4096): string {
  const tail = "\n… (full reply in kinoko)";
  return text.length <= max ? text : `${text.slice(0, max - tail.length)}${tail}`;
}

/** The pairing code in a message: "/start 123456", "/start@bot 123456" or the code alone. */
export function pairingCodeIn(text: string): string | undefined {
  return /^(?:\/start(?:@\w+)?\s+)?(\d{6})\s*$/.exec(text.trim())?.[1];
}

/** Waits for a private message carrying `code`, from updates after the ones already there. */
export async function waitForPairing(api: Telegram, code: string, signal: AbortSignal, poll = 25): Promise<TgMessage> {
  // Updates sent before the code was shown do not count: start after the newest one.
  const old = await api.getUpdates(-1, 0, signal);
  let offset = old.length > 0 ? (old.at(-1)?.update_id ?? 0) + 1 : undefined;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- long polling: one request at a time
    const updates = await api.getUpdates(offset, poll, signal);
    for (const u of updates) {
      offset = u.update_id + 1;
      const m = u.message;
      if (m?.chat.type === "private" && pairingCodeIn(m.text ?? "") === code) {
        // Confirms the update, so the bridge will not see it again.
        // oxlint-disable-next-line no-await-in-loop -- once, on the way out of the loop
        await api.getUpdates(offset, 0, signal).catch(() => undefined);
        return m;
      }
    }
  }
}
