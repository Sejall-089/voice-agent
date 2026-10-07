import type { RemoteResult } from "./types.ts";

// An MCP result as ONE string (M19).
//
// Every `ToolHandler` returns `Promise<string>`, and a chain passes a step's result to a later
// one only as whole text via `{stepN}` (spec §5b). So whatever identifies the thing a tool made
// — a link, an id — has to be IN that text, or the next step cannot mention it.
//
// Recon found Linear puts everything in a single text block. This handles the other two places
// the protocol allows a link to live anyway, because the adapter is generic and the next
// connector will not be Linear:
//
//   - text blocks, in order, joined by newlines;
//   - a `resource_link` / `resource` block becomes a line with its name and URI;
//   - `structuredContent` is used ONLY when there was no text at all. A server that sends both
//     sends the same data twice, and appending the second copy would double every result.
//
// Images, audio and anything else are dropped: there is nothing a string-returning tool can do
// with them.
export function flattenResult(result: RemoteResult): string {
  const lines: string[] = [];
  for (const block of result.content) {
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text.trim().length > 0) lines.push(block.text);
      continue;
    }
    if (typeof block.uri === "string" && block.uri.length > 0) {
      lines.push(block.name ? `${block.name}: ${block.uri}` : block.uri);
    }
  }
  if (lines.length > 0) return lines.join("\n");

  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return JSON.stringify(result.structuredContent);
  }
  return "";
}

// The human-readable part of an `isError` result. Recon captured two formats from one server:
// a bare sentence, sometimes prefixed "Error: ", and JSON carrying a `message`.
export function failureText(text: string): string {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const message = (parsed as Record<string, unknown>)["message"];
      if (typeof message === "string" && message.trim().length > 0) return message.trim();
    }
  } catch {
    // Not JSON — the bare-sentence format.
  }
  return trimmed.replace(/^Error:\s*/i, "");
}
