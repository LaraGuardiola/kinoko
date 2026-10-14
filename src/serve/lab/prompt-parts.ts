// The system prompt (src/prompt.ts) taken apart for a reader: who the model is told it is, the
// tools by name, where and when, each context file, the skills. Put back together, the parts are
// the prompt, byte for byte.

export interface PromptPart {
  label: string;
  text: string;
}

const CONTEXT = /<ctx path="([^"]*)">[\s\S]*?<\/ctx>/g;

export function promptParts(system: string): PromptPart[] {
  const parts: PromptPart[] = [];
  let rest = system;
  const take = (label: string, end: number): void => {
    if (end <= 0) return;
    parts.push({ label, text: rest.slice(0, end) });
    rest = rest.slice(end);
  };
  // The persona runs up to the tools line; the tools line, then the date block, up to what was found.
  take("Who the model is told it is", indexOr(rest, "\n\nTools: ", rest.length));
  if (rest.startsWith("\n\nTools: ")) take("The tools, by name", indexOr(rest, "\n\nDate: ", rest.length));
  if (rest.startsWith("\n\nDate: ")) take("Where and when", firstOf(rest, ["\n\n<ctx ", "\n\n<skills>"], rest.length));
  while (rest.startsWith("\n\n<ctx ")) {
    CONTEXT.lastIndex = 0;
    const found = CONTEXT.exec(rest);
    if (found === null) break;
    take(`Context: ${found[1]}`, found.index + found[0].length);
  }
  if (rest.length > 0) take(rest.startsWith("\n\n<skills>") ? "Skills (their names and descriptions only)" : "More", rest.length);
  return parts;
}

function indexOr(text: string, needle: string, fallback: number): number {
  const at = text.indexOf(needle);
  return at < 0 ? fallback : at;
}

function firstOf(text: string, needles: string[], fallback: number): number {
  const found = needles.map((n) => text.indexOf(n)).filter((at) => at >= 0);
  return found.length > 0 ? Math.min(...found) : fallback;
}
