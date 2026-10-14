// Is the model kinoko starts with one its endpoint serves? A local engine (llama.cpp, Strata)
// answers whatever the request names with the model it has loaded, so a config.json naming another
// file goes unnoticed: kinoko shows one model while another one replies.

import { modelName } from "../prompt.ts";

/** What to tell the user when `model` is not among what the endpoint serves; undefined when it is
 *  (or the endpoint did not say). */
export function mismatchNote(model: string, served: string[], host: string): string | undefined {
  if (model === "" || served.length === 0 || served.includes(model)) return undefined;
  const names = served.slice(0, 3).map(modelName);
  const more = served.length > 3 ? ` and ${served.length - 3} more` : "";
  const what = served.length === 1 ? `it serves ${names[0]}` : `it serves ${names.join(", ")}${more}`;
  return `${modelName(model)} is not what ${host} serves: ${what}. In /models, D on the right one makes it the default.`;
}
