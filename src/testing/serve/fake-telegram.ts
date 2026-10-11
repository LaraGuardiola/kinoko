// A fake Bot API for the tests: getMe for one good token, getUpdates held until an update comes (so
// long polling is real, though short), and every call recorded.

import type { TgUpdate } from "../../serve/telegram.ts";

export const GOOD_TOKEN = "123456:good-token-for-tests";

export interface FakeTelegram {
  base: string;
  calls: Array<{ method: string; body: Record<string, unknown> }>;
  /** An update for the next getUpdates (ids are given in order). */
  push: (update: Omit<TgUpdate, "update_id">) => void;
  /** A file the bot can download, by its file_id. */
  file: (id: string, bytes: Uint8Array) => void;
  stop: () => void;
}

export function fakeTelegram(): FakeTelegram {
  const updates: TgUpdate[] = [];
  let nextId = 100;
  let wake: (() => void) | undefined;
  const calls: FakeTelegram["calls"] = [];
  const files = new Map<string, Uint8Array>();
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const parts = new URL(req.url).pathname.split("/");
      // A file's bytes: /file/bot<token>/<path>.
      if (parts[1] === "file") return parts[2] === `bot${GOOD_TOKEN}` ? new Response(files.get(parts.slice(3).join("/")) ?? "", { status: files.has(parts.slice(3).join("/")) ? 200 : 404 }) : new Response("", { status: 401 });
      const [, bot, method] = parts;
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      calls.push({ method: method ?? "", body });
      if (bot !== `bot${GOOD_TOKEN}`) return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
      if (method === "getMe") return Response.json({ ok: true, result: { id: 1, username: "kinoko_test_bot", first_name: "Kinoko" } });
      if (method === "getUpdates") {
        const offset = typeof body.offset === "number" ? body.offset : undefined;
        const pick = (): TgUpdate[] => (offset === -1 ? updates.slice(-1) : updates.filter((u) => offset === undefined || u.update_id >= offset));
        if (pick().length === 0 && Number(body.timeout) > 0) {
          // Held, as Telegram does, until something comes (or a short while: tests stay quick).
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 300);
          });
        }
        return Response.json({ ok: true, result: pick() });
      }
      if (method === "getFile") return Response.json({ ok: true, result: { file_id: body.file_id, file_path: `docs/${String(body.file_id)}` } });
      if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: calls.length, chat: { id: body.chat_id, type: "private" }, text: body.text } });
      return Response.json({ ok: true, result: true });
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    calls,
    push: (update) => {
      updates.push({ update_id: nextId++, ...update });
      wake?.();
    },
    file: (id, bytes) => void files.set(`docs/${id}`, bytes),
    stop: () => void server.stop(true),
  };
}

/** A private text message from the user, as an update. */
export function said(text: string, chat = 777, type = "private"): Omit<TgUpdate, "update_id"> {
  return { message: { message_id: 1, chat: { id: chat, type }, from: { id: chat, first_name: "Lara" }, text } };
}
