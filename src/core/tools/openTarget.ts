import { UnresolvedReferenceError } from "../errors.ts";
import type { Tool, ToolDeps, ToolInput } from "../types.ts";

// Recognizes a value that is ALREADY a URL and normalizes it. It resolves nothing — there is
// deliberately no lookup table of the user's personal targets here. Mapping a vague reference
// like "my dashboard" to a URL is memory's job (spec.md §7), and it arrives in M3 through the
// resolver seam filling `url` — with no change to this file.
function asUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  // Already an absolute http(s) URL.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).toString();
    } catch {
      return null;
    }
  }

  // A bare host with a TLD ("youtube.com", "docs.google.com/x") — assume https.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(trimmed)) {
    try {
      return new URL(`https://${trimmed}`).toString();
    } catch {
      return null;
    }
  }

  return null;
}

// Task 3 (spec.md §6): open a named target. The LLM resolves what it legitimately knows
// (a literal URL, or a well-known public site). A vague personal reference flows through the
// planner's resolve step unchanged (M2's NoopMemoryResolver) and this handler refuses to
// fabricate a URL for it.
export const openTargetTool: Tool = {
  name: "openTarget",
  description:
    "Open a named target in the browser. Use this when the user asks to open, launch, go to, or " +
    "pull up a site or link. Always pass `target` as the name the user used, verbatim. Set `url` " +
    "ONLY when you are certain of the public canonical URL (e.g. 'youtube' -> " +
    "'https://youtube.com'). For personal or private references (e.g. 'my dashboard', " +
    "'my upwork'), leave `url` empty — do not guess.",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "The target as the user named it, verbatim (e.g. 'youtube', 'my dashboard').",
      },
      url: {
        type: "string",
        description:
          "The canonical URL, only if you are certain of it. Leave empty for personal references.",
      },
    },
    required: ["target"],
  },
  risk: "reversible",
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const target = typeof input["target"] === "string" ? input["target"] : "";

    // Prefer an explicit url (from the LLM now, from memory in M3); fall back to the target
    // itself when the user simply typed a URL.
    const url = asUrl(input["url"]) ?? asUrl(target);

    if (url === null) {
      throw new UnresolvedReferenceError(
        `I don't know what "${target}" refers to yet — teach me with: remember ${target} is <the URL>.`,
      );
    }

    const result = await deps.shell.executeAction({ kind: "openUrl", payload: url });
    if (!result.ok) {
      throw new Error(result.error ?? `Could not open ${url}.`);
    }

    return `Opened ${url}`;
  },
};
