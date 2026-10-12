// Line endings. Models write "\n"; a Windows file may use "\r\n". A file keeps the endings it has.

/** The file uses CRLF: more "\r\n" than lone "\n". */
export function isCrlf(text: string): boolean {
  const crlf = text.split("\r\n").length - 1;
  return crlf > 0 && crlf >= text.split("\n").length - 1 - crlf;
}

/** `text` with the file's endings: CRLF files get CRLF, others what they were given. */
export function withEndings(text: string, crlf: boolean): string {
  return crlf ? text.replace(/\r?\n/g, "\r\n") : text;
}
