export interface ContextMention {
  kind: "file" | "symbol";
  value: string;
}

/** Supports @file:path, @file(path), and quoted paths/symbols with spaces. */
export function parseMentions(instruction: string): ContextMention[] {
  const result: ContextMention[] = [];
  const pattern =
    /@(file|symbol)(?::|\s+|\()(?:(?:"([^"\r\n]+)"|'([^'\r\n]+)')|([^\s)]+))\)?/gi;
  for (const match of instruction.matchAll(pattern)) {
    const kind = match[1].toLowerCase() as ContextMention["kind"];
    const value = (match[2] ?? match[3] ?? match[4]).replace(/[.,;!?]+$/, "");
    if (
      value &&
      !result.some(
        (mention) => mention.kind === kind && mention.value === value,
      )
    )
      result.push({ kind, value });
  }
  return result;
}
