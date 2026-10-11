import { afterAll, describe, expect, test } from "bun:test";
import { Telegram, TelegramError, capMessage, escapeHtml, pairingCodeIn, waitForPairing } from "../../serve/telegram.ts";
import { GOOD_TOKEN, fakeTelegram, said } from "./fake-telegram.ts";

const tg = fakeTelegram();
afterAll(() => tg.stop());

describe("serve: telegram", () => {
  test("getMe with a good token; a bad one is a 401 whose message never holds the token", async () => {
    expect((await new Telegram(GOOD_TOKEN, tg.base).getMe(AbortSignal.timeout(2000))).username).toBe("kinoko_test_bot");
    const bad = await new Telegram("999:secret-bad", tg.base).getMe(AbortSignal.timeout(2000)).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(TelegramError);
    expect((bad as TelegramError).status).toBe(401);
    expect((bad as Error).message).not.toContain("secret-bad");
  });

  test("no answer at all: status 0, the token cut out of the message", async () => {
    const e = (await new Telegram("999:secret-gone", "http://127.0.0.1:1").getMe(AbortSignal.timeout(2000)).catch((x: unknown) => x)) as TelegramError;
    expect(e.status).toBe(0);
    expect(e.message).toStartWith("could not reach Telegram");
    expect(e.message).not.toContain("secret-gone");
  });

  test("sendMessage goes as HTML, with buttons and a reply when asked", async () => {
    await new Telegram(GOOD_TOKEN, tg.base).sendMessage(5, "<b>hi</b>", AbortSignal.timeout(2000), { buttons: [[{ text: "ok", callback_data: "x" }]], replyTo: 9 });
    expect(tg.calls.at(-1)?.body).toMatchObject({ chat_id: 5, text: "<b>hi</b>", parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "ok", callback_data: "x" }]] }, reply_parameters: { message_id: 9 } });
  });

  test("pairing: older messages, wrong codes and groups are ignored; the right code in a private chat pairs", async () => {
    tg.push(said("/start 111111")); // sent before the code was shown
    const api = new Telegram(GOOD_TOKEN, tg.base);
    const waiting = waitForPairing(api, "111111", AbortSignal.timeout(3000), 1);
    await new Promise((r) => setTimeout(r, 50));
    tg.push(said("/start 000000"));
    tg.push(said("/start 111111", -5, "group"));
    tg.push(said("/start@kinoko_test_bot 111111", 42));
    const message = await waiting;
    expect(message.chat.id).toBe(42);
  });

  test("an abort stops the wait at once", async () => {
    const stop = new AbortController();
    const waiting = waitForPairing(new Telegram(GOOD_TOKEN, tg.base), "222222", stop.signal, 1);
    await new Promise((r) => setTimeout(r, 30));
    const at = Date.now();
    stop.abort();
    await waiting.catch(() => undefined);
    expect(Date.now() - at).toBeLessThan(100);
  });

  test("text helpers: HTML escaping, the 4096 cap, codes", () => {
    expect(escapeHtml("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
    const long = capMessage("x".repeat(5000));
    expect(long.length).toBe(4096);
    expect(long).toEndWith("… (full reply in kinoko)");
    expect(capMessage("short")).toBe("short");
    expect(pairingCodeIn("/start 123456")).toBe("123456");
    expect(pairingCodeIn(" 123456 ")).toBe("123456");
    expect(pairingCodeIn("/start 12345")).toBeUndefined();
    expect(pairingCodeIn("hello 123456")).toBeUndefined();
  });
});
