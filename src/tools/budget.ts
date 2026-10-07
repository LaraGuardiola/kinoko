export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Keeps tool output under a token budget (estimated as chars/4).
 * When over budget: keep head + tail, spill the FULL output to
 * `.kinoko/spill/<id>.txt` and tell the model where it is. Never drops data silently.
 */
export async function budget(output: string, opts: { maxTokens: number; id: string }): Promise<string> {
  const maxChars = opts.maxTokens * 4;
  if (output.length <= maxChars) return output;
  const half = Math.floor(maxChars / 2);
  const head = output.slice(0, half);
  const tail = output.slice(-half);
  await Bun.write(spillPath(opts.id), output);
  const note = `[output truncated: full ${output.length} chars (${estimateTokens(output)} tokens) in ${spillPath(opts.id)} — use read with offset/limit to page through it]`;
  return `${head}\n\n${note}\n\n${tail}`;
}

function spillPath(id: string): string {
  return `.kinoko/spill/${id}.txt`;
}
