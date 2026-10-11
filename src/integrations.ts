// Integrations set up from the TUI's menu (Telegram for now): ~/.kinoko/integrations.json, mode 600,
// written atomically (it holds a bot token). `kinoko serve` reads it and runs the bridge.

import { chmod, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

export interface TelegramSettings {
  token: string;
  /** The bot's username (no @). */
  bot: string;
  /** The one private chat obeyed; unset until paired. */
  chat?: number;
  /** The paired person's name, as Telegram gives it. */
  name?: string;
  /** Tell when a run ends. */
  notify: boolean;
  /** Take prompts (and commands) from the chat. */
  prompts: boolean;
  /** Ask approvals there too. */
  approvals: boolean;
  /** The bridge runs (while `kinoko serve` does). */
  on: boolean;
}

export interface Integrations {
  telegram?: TelegramSettings;
}

export function integrationsFile(home: string): string {
  return join(home, ".kinoko", "integrations.json");
}

export async function readIntegrations(home: string): Promise<Integrations> {
  try {
    const data = (await Bun.file(integrationsFile(home)).json()) as Integrations;
    const t = data.telegram;
    if (t === undefined || typeof t.token !== "string" || t.token === "") return {};
    return {
      telegram: {
        token: t.token,
        bot: typeof t.bot === "string" ? t.bot : "",
        ...(typeof t.chat === "number" ? { chat: t.chat } : {}),
        ...(typeof t.name === "string" ? { name: t.name } : {}),
        notify: t.notify !== false,
        prompts: t.prompts !== false,
        approvals: t.approvals !== false,
        on: t.on !== false,
      },
    };
  } catch {
    return {};
  }
}

let writes = 0;

/** Written beside and renamed, mode 600: a crash mid-write never leaves half a token. */
export async function writeIntegrations(home: string, all: Integrations): Promise<void> {
  const path = integrationsFile(home);
  await mkdir(join(home, ".kinoko"), { recursive: true });
  const tmp = `${path}.${process.pid}.${++writes}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(all, null, 2)}\n`);
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/** Changes Telegram's settings (undefined forgets them: Disconnect). */
export async function setTelegram(home: string, change: (current: TelegramSettings | undefined) => TelegramSettings | undefined): Promise<TelegramSettings | undefined> {
  const all = await readIntegrations(home);
  const next = change(all.telegram);
  if (next === undefined) delete all.telegram;
  else all.telegram = next;
  await writeIntegrations(home, all);
  return next;
}
