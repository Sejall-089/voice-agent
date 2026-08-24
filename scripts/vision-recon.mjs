// M15 task 1b — reconnaissance against the REAL vision model, before FakeVisionLocator is
// written and before any coordinate is trusted.
//
// WHY THIS EXISTS, and what is different about it. The other recon scripts in this folder
// interrogate someone else's contract: Notion's DOM, Piper's stderr. Here the RESPONSE SHAPE IS
// OURS — the model answers through a tool schema this repo defines, so "what do the fields look
// like" is not the open question. Three other things are, and none can be answered from a
// fixture:
//
//   V1  Does the model actually comply with the schema, every time?
//   V2  When the thing is NOT on screen, does it use the notFound branch — or does it invent a
//       plausible box? This is the single most important question in the milestone. A model that
//       hallucinates coordinates rather than declining turns "point at it" into "point
//       confidently at the wrong thing", and every deterministic check in core/vision/locate.ts
//       exists because the answer here cannot be assumed to be good.
//   V3  When several things match, does it use the ambiguous branch or silently pick one?
//   V4  HOW ACCURATE is the box, and what does the downscale cost? Asked at full resolution and
//       at the 1568-long-edge downscale the app actually sends, against the same target.
//
// It writes an HTML file per probe with the returned box drawn over the screenshot, because
// "the coordinates looked about right" is not a measurement — open it and see whether the
// rectangle is ON the button.
//
//   1. Capture a screenshot to work from:
//        npx electron scripts/screen-recon.mjs --keep --out screen-recon-out
//      (or point --image at any PNG of a screen)
//   2. Set ANTHROPIC_API_KEY in .env — this milestone's vision call is Anthropic-only.
//   3. node scripts/vision-recon.mjs --image screen-recon-out/q2-full.png --target "the Send button"
//
// Flags:
//   --image <path>    the screenshot to interrogate  (required)
//   --target <text>   the element to look for        (default: "the close button")
//   --absent <text>   something definitely NOT on screen, for V2
//                     (default: "the espresso machine")
//   --ambiguous <text> something there are several of, for V3  (default: "a button")
//   --model <id>      override the model             (default: claude-opus-5)
//   --out <dir>       where the marked-up HTML lands (default: <tmp>/vision-recon)

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1];
};

function fromEnvFile(key) {
  try {
    const line = readFileSync(new URL("../.env", import.meta.url), "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${key}=`));
    const value = line === undefined ? "" : line.slice(key.length + 1).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

const IMAGE = flag("--image", null);
const TARGET = flag("--target", "the close button");
const ABSENT = flag("--absent", "the espresso machine");
const AMBIGUOUS = flag("--ambiguous", "a button");
const MODEL = flag("--model", "claude-opus-5");
const OUT_DIR = flag("--out", join(tmpdir(), "vision-recon"));
const API_KEY = process.env["ANTHROPIC_API_KEY"] ?? fromEnvFile("ANTHROPIC_API_KEY");

if (!IMAGE) {
  console.error(
    "Need a screenshot to interrogate.\n" +
      "  npx electron scripts/screen-recon.mjs --keep --out screen-recon-out\n" +
      "  node scripts/vision-recon.mjs --image screen-recon-out/q2-full.png",
  );
  process.exit(1);
}
if (!API_KEY) {
  console.error(
    "ANTHROPIC_API_KEY is not set (checked the environment and .env).\n" +
      "M15's vision call is Anthropic-only — see spec.md §3. Nothing here can run without it.",
  );
  process.exit(1);
}

// THE SCHEMA. This is the contract core/vision/AnthropicVisionLocator.ts implements, kept
// verbatim in both places on purpose: recon that asks a different question than the app asks
// proves nothing about the app.
const LOCATE_TOOL = {
  name: "locate_element",
  description:
    "Report where the requested element is in the screenshot, or that you cannot identify it.",
  input_schema: {
    type: "object",
    properties: {
      outcome: {
        type: "string",
        enum: ["found", "notFound", "ambiguous"],
        description:
          "found: exactly one element clearly matches. notFound: nothing on screen matches. " +
          "ambiguous: several things match and you cannot tell which was meant.",
      },
      box: {
        type: "object",
        description:
          "Only when outcome is 'found'. The element's bounding box in IMAGE PIXELS, origin at " +
          "the top-left of the image. Tight around the element itself, not its container.",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
        },
        required: ["x", "y", "width", "height"],
      },
      label: {
        type: "string",
        description:
          "Only when outcome is 'found'. What the element actually is, as a person would name " +
          "it — its visible text where it has any.",
      },
      candidates: {
        type: "array",
        items: { type: "string" },
        description: "Only when outcome is 'ambiguous'. The competing matches, named.",
      },
      reason: {
        type: "string",
        description: "Only when outcome is 'notFound'. One short sentence a person can act on.",
      },
    },
    required: ["outcome"],
  },
};

const SYSTEM = [
  "You locate one user-interface element in a screenshot of someone's screen.",
  "You are pointing it out to the person so THEY can click it — you never click anything.",
  "Answer only through the locate_element tool.",
  "Report coordinates in image pixels, with the origin at the top-left of the image.",
  "Accuracy matters more than helpfulness: if the element is not clearly visible, say notFound.",
  "If several elements match the description and you cannot tell which was meant, say ambiguous.",
  "Never guess a box you are not confident in — a confident wrong answer sends the person to the",
  "wrong part of their screen, which is worse than admitting you cannot tell.",
].join(" ");

const client = new Anthropic({ apiKey: API_KEY });

function pngSize(buffer) {
  // PNG: 8-byte signature, then IHDR — width/height are big-endian uint32 at offsets 16 and 20.
  if (buffer.length < 24) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function ask(imageBase64, target) {
  const started = Date.now();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM,
    tools: [LOCATE_TOOL],
    tool_choice: { type: "tool", name: "locate_element" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: imageBase64 } },
          { type: "text", text: `Find: ${target}` },
        ],
      },
    ],
  });
  const call = response.content.find((block) => block.type === "tool_use");
  return {
    elapsedMs: Date.now() - started,
    stopReason: response.stop_reason,
    usage: response.usage,
    input: call ? call.input : null,
    raw: response.content,
  };
}

// Draw the returned box over the screenshot so accuracy is SEEN, not asserted.
function writeMarkup(name, imageBase64, size, box, caption) {
  const path = join(OUT_DIR, `${name}.html`);
  const rect =
    box === null
      ? ""
      : `<div style="position:absolute;left:${box.x}px;top:${box.y}px;` +
        `width:${box.width}px;height:${box.height}px;border:3px solid #ff00ff;` +
        `box-shadow:0 0 0 9999px rgba(0,0,0,.35)"></div>`;
  writeFileSync(
    path,
    `<!doctype html><meta charset="utf-8"><title>${name}</title>` +
      `<p style="font:14px system-ui">${caption}</p>` +
      `<div style="position:relative;width:${size.width}px;height:${size.height}px">` +
      `<img src="data:image/png;base64,${imageBase64}" width="${size.width}" height="${size.height}">` +
      `${rect}</div>`,
  );
  return path;
}

function heading(text) {
  console.log(`\n${"=".repeat(78)}\n${text}\n${"=".repeat(78)}`);
}

function report(label, result) {
  console.log(`  ${label}`);
  console.log(`    stop_reason=${result.stopReason}  ${result.elapsedMs} ms`);
  console.log(
    `    tokens: in=${result.usage?.input_tokens} out=${result.usage?.output_tokens}`,
  );
  console.log(`    input: ${JSON.stringify(result.input)}`);
  if (result.input === null) {
    console.log(`    RAW (no tool_use block!): ${JSON.stringify(result.raw)}`);
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const buffer = readFileSync(IMAGE);
  const size = pngSize(buffer);
  const base64 = buffer.toString("base64");
  console.log(
    `image: ${basename(IMAGE)}  ${size ? `${size.width}x${size.height}` : "(size unknown)"}  ` +
      `${(buffer.length / 1024).toFixed(1)} KB  → ${(base64.length / 1024).toFixed(1)} KB base64`,
  );
  console.log(`model: ${MODEL}`);

  // --- V1: something that is there -------------------------------------------------------
  heading(`V1 — a target that IS on screen: ${JSON.stringify(TARGET)}`);
  const found = await ask(base64, TARGET);
  report("present target", found);
  if (found.input?.outcome === "found" && found.input.box && size) {
    const path = writeMarkup(
      "v1-found",
      base64,
      size,
      found.input.box,
      `V1 — asked for ${TARGET}; model said ${JSON.stringify(found.input.label)}`,
    );
    console.log(`    OPEN THIS: ${path}`);
    console.log(
      "    Is the magenta rectangle ON the element? That is V4's real answer — a box that is\n" +
        "    150px off is a marker that lands on the wrong control with total confidence.",
    );
  }

  // --- V2: something that is NOT there ---------------------------------------------------
  heading(`V2 — a target that is NOT on screen: ${JSON.stringify(ABSENT)}`);
  console.log(
    "  THE MOST IMPORTANT PROBE. A box here instead of notFound means the model hallucinates\n" +
      "  coordinates under pressure, and core/vision/locate.ts's checks are the only thing\n" +
      "  standing between that and a confidently wrong marker.\n",
  );
  const absent = await ask(base64, ABSENT);
  report("absent target", absent);
  if (absent.input?.outcome === "found") {
    console.log(
      "    *** HALLUCINATED A BOX FOR SOMETHING THAT IS NOT THERE ***\n" +
        "    Record this in spec.md. It does not sink the milestone — it decides how hard the\n" +
        "    deterministic checks have to be, and it belongs in the prompt as a counterexample.",
    );
    if (size) {
      console.log(
        `    OPEN THIS: ${writeMarkup("v2-hallucinated", base64, size, absent.input.box, `V2 — asked for ${ABSENT} (not present); model boxed it anyway`)}`,
      );
    }
  }

  // --- V3: several things match ----------------------------------------------------------
  heading(`V3 — an ambiguous target: ${JSON.stringify(AMBIGUOUS)}`);
  const ambiguous = await ask(base64, AMBIGUOUS);
  report("ambiguous target", ambiguous);
  if (ambiguous.input?.outcome === "found") {
    console.log(
      "    Model picked one rather than declining. Same note as V2: this is the behaviour the\n" +
        "    zero-or-many rule has to survive, transcribed rather than assumed.",
    );
  }

  // --- V4: what the downscale costs ------------------------------------------------------
  heading("V4 — full resolution vs. the downscale the app actually sends");
  console.log(
    "  Re-run this script against the DOWNSCALED frame and compare V1's box, in the same\n" +
      "  fraction-of-the-screen terms:\n" +
      "    node scripts/vision-recon.mjs --image screen-recon-out/q6-downscaled.png " +
      `--target ${JSON.stringify(TARGET)}\n`,
  );
  if (found.input?.outcome === "found" && found.input.box && size) {
    const b = found.input.box;
    console.log(
      `  V1 box as a fraction of the frame: x=${(b.x / size.width).toFixed(4)} ` +
        `y=${(b.y / size.height).toFixed(4)} w=${(b.width / size.width).toFixed(4)} ` +
        `h=${(b.height / size.height).toFixed(4)}`,
    );
    console.log(
      "  Those four fractions should barely move between the two resolutions. If they do, the\n" +
        "  downscale is costing real accuracy and the long edge needs to go up.",
    );
  }

  heading("what to do with this");
  console.log(
    "  Transcribe V1-V4 into spec.md §6d, then write tests/FakeVisionLocator.ts to replay them\n" +
      "  — including whatever V2 and V3 actually did. Writing the fake from what the model\n" +
      "  OUGHT to do is how a suite passes against a model that does something else.\n\n" +
      `  The marked-up HTML in ${OUT_DIR} contains your screen. Look, then delete.`,
  );
}

main().catch((error) => {
  console.error("\nrecon failed:", error);
  process.exit(1);
});
