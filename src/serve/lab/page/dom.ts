// The page's one DOM helper. Text always goes in as text, never as HTML: an agent's output is data.

type Child = Node | string | undefined | false;

/** A DOM element in one line: tag.class, attributes, children (strings become text). */
export function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const [name, ...classes] = tag.split(".");
  const node = document.createElement(name || "div");
  if (classes.length > 0) node.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const child of children) if (child !== undefined && child !== false) node.append(child);
  return node;
}

/** Folded text: a summary line, the whole thing inside. `key` keeps it unfolded across redraws. */
export function fold(key: string, summary: string, body: Child, open = false): HTMLElement {
  const details = h("details", { "data-key": key }, h("summary", {}, summary), body);
  if (open) details.setAttribute("open", "");
  return details;
}

/** A block of verbatim text. */
export const pre = (text: string, cls = ""): HTMLElement => h(`pre${cls ? `.${cls}` : ""}`, {}, text);

/** A small two-column table of facts. */
export function facts(rows: Array<[string, string]>): HTMLElement {
  return h("dl.facts", {}, ...rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
}

export const section = (title: string, ...children: Child[]): HTMLElement => h("section", {}, h("h3", {}, title), ...children);
