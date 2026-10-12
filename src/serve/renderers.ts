// The phone's ```mermaid and the like, drawn by the extensions' renderers. The hub runs for days and
// what is switched on (/extensions, a profile) or installed changes under it: before a drawing, it
// looks whether that changed, and loads the extensions again if so.

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Extensions, loadExtensions } from "../ext.ts";
import { setFenceRenderers } from "../tui/markdown.ts";

async function mtime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/** Keeps the fence renderers in step with ~/.kinoko: `fresh()` before each drawing. */
export function fenceRenderers(home: string, log: (line: string) => void = () => undefined): { fresh: () => Promise<void> } {
  let stamp = "";
  let loading: Promise<void> | undefined;
  const reload = async (): Promise<void> => {
    const now = (await Promise.all([join(home, ".kinoko", "disabled.json"), join(home, ".kinoko", "ext")].map(mtime))).join("|");
    if (now === stamp) return;
    const ext = new Extensions(log);
    await loadExtensions(ext, { cwd: home, home });
    setFenceRenderers((lang) => ext.renderer(lang));
    stamp = now;
  };
  return {
    fresh: () => {
      // One look at a time: the drawings asked meanwhile wait for it.
      loading ??= reload().finally(() => (loading = undefined));
      return loading;
    },
  };
}
