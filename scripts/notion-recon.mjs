// M11 task 0 — live DOM reconnaissance for Notion in the debug Chrome.
//
// WHY THIS EXISTS. M10's jsdom fixture was hand-authored from an assumption about Gmail's
// markup: that the Reply control was `role="button"`. Every test passed. It was `role="link"`,
// and only a live page ever said so. This script exists so M11's fixture is TRANSCRIBED from
// the real DOM instead of imagined, and so every selector in `notionScript.ts` can cite an
// observation rather than a guess.
//
// Plain ESM, run directly with node. No build step, no new dependency — `ws` is already a
// dependency of this repo (CdpClient uses it) and `fetch` is built in.
//
//   1. Start the debug Chrome (same one Gmail uses — one browser, several apps in it):
//        chrome.exe --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\voice-agent-chrome"
//   2. Open a THROWAWAY Notion page in it. Not a real one: see --probe-insert below.
//   3. node scripts/notion-recon.mjs
//
// Flags:
//   --url <base>       Chrome's debug endpoint (default: CHROME_DEBUG_URL, else localhost:9222)
//   --out <file>       Where to write the dump (default: <tmp>/notion-recon.json)
//   --probe-insert     ALSO run the R4 insertion experiment, which WRITES TEXT INTO THE PAGE.
//                      Off by default and deliberately opt-in: everything else here is
//                      read-only, and a recon tool should not modify the thing it is surveying
//                      unless asked. Only ever point this at a scratch page.

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

// --- argument parsing (tiny; this is a dev script, not a CLI) ---

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(name);

function envDebugUrl() {
  // Read .env directly rather than pulling in dotenv: this script runs outside the app.
  try {
    const line = readFileSync(new URL("../.env", import.meta.url), "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith("CHROME_DEBUG_URL="));
    const value = line === undefined ? "" : line.slice("CHROME_DEBUG_URL=".length).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

const BASE_URL = flag("--url", envDebugUrl() ?? "http://localhost:9222").replace(/\/$/, "");
const OUT_FILE = flag("--out", join(tmpdir(), "notion-recon.json"));
const PROBE_INSERT = has("--probe-insert");

// Which hosts count as Notion (R8). Deliberately broad here — the point of recon is to SEE
// what the real tab URLs look like, then narrow the production filter to what was observed.
const NOTION_HOST = /(^|\.)notion\.(so|site|com)$/i;

// --- the recon function, run inside the page ---
//
// Self-contained for the same reason `gmailScript.ts` is: it is shipped into the page via
// toString(), so it may not import or close over anything. Read-only except for the R4 probe,
// which is gated on its own argument.

async function notionRecon(doc, probeInsert) {
  const cap = (s, n) => {
    const t = (s === null || s === undefined ? "" : String(s)).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  };

  // Every attribute on an element, so nothing is filtered out by an assumption about what
  // matters. Class lists in Notion are long, so they are capped rather than dropped.
  const describe = (el) => {
    if (el === null || el === undefined) return null;
    const attrs = {};
    for (const name of el.getAttributeNames()) attrs[name] = cap(el.getAttribute(name), 160);
    return {
      tag: el.tagName,
      attrs,
      role: el.getAttribute("role"),
      contentEditable: el.getAttribute("contenteditable"),
      text: cap(el.textContent, 120),
      childCount: el.children.length,
    };
  };

  const all = (sel) => Array.from(doc.querySelectorAll(sel));
  const out = {};

  // --- page identity ---
  out.page = {
    url: doc.location === undefined ? null : doc.location.href,
    title: doc.title,
    visibilityState: doc.visibilityState, // R6
    hasFocus: typeof doc.hasFocus === "function" ? doc.hasFocus() : null, // R6
  };

  // --- R1: the editor surface, and whether ANY aria roles exist on it ---
  const editables = all('[contenteditable="true"]');
  out.R1_editor = {
    contentEditableCount: editables.length,
    // The first few in document order, fully described. "First few" is a recon convenience,
    // NOT a selection strategy — production code must never pick a target by index.
    samples: editables.slice(0, 6).map(describe),
    knownContainers: {
      ".notion-page-content": describe(doc.querySelector(".notion-page-content")),
      ".notion-frame": describe(doc.querySelector(".notion-frame")),
      ".notion-scroller": describe(doc.querySelector(".notion-scroller")),
    },
    // The load-bearing question: if this comes back empty or tiny, Gmail's role+accessible-name
    // predicate simply does not apply to Notion's editor, and that is a finding to write down.
    rolesPresentOnPage: (() => {
      const counts = {};
      for (const el of all("[role]")) {
        const r = el.getAttribute("role");
        counts[r] = (counts[r] ?? 0) + 1;
      }
      return counts;
    })(),
    ariaLabelsSample: all("[aria-label]")
      .slice(0, 25)
      .map((el) => ({ role: el.getAttribute("role"), label: cap(el.getAttribute("aria-label"), 80) })),
  };

  // --- R2: the page title element ---
  out.R2_title = {
    byPlaceholder: all("[placeholder]").slice(0, 8).map(describe),
    notionTitleClass: describe(doc.querySelector(".notion-title")),
    h1: describe(doc.querySelector("h1")),
    pageBlock: describe(doc.querySelector(".notion-page-block")),
  };

  // --- R3: block identity ---
  const blocks = all("[data-block-id]");
  out.R3_blocks = {
    count: blocks.length,
    first: describe(blocks[0]),
    last: describe(blocks[blocks.length - 1]),
    // Whether a block's own editable child is reachable from the block, which is what an
    // append needs in order to aim at the end of the LAST block.
    lastEditableChild: describe(
      blocks.length > 0 ? blocks[blocks.length - 1].querySelector('[contenteditable="true"]') : null,
    ),
  };

  // --- R5: is there a clickable empty area below the last block? ---
  // Notion renders a click target under the content that appends a new block. If it exists and
  // is identifiable, it is a far safer append anchor than caret arithmetic on existing text —
  // clicking Notion's OWN "add a block after this" affordance rather than us guessing at caret
  // placement inside a block that (per R1) is not statically contenteditable at all.
  out.R5_appendAnchor = {
    byAriaLabel: all("[aria-label]")
      .filter((el) => /click to add|add a block|add below|add new block/i.test(el.getAttribute("aria-label") ?? ""))
      .map(describe),
    byClassGuess: ["div.notion-page-content > div:last-child", ".notion-selectable:last-child"].map(
      (sel) => ({ selector: sel, found: describe(doc.querySelector(sel)) }),
    ),
    selectionApiPresent: {
      getSelection: typeof doc.getSelection === "function",
      createRange: typeof doc.createRange === "function",
      execCommand: typeof doc.execCommand === "function",
    },
  };

  // --- R7: locked / read-only signals ---
  out.R7_locked = {
    // A locked Notion page renders its blocks non-editable. If contenteditable="false" shows up
    // on content blocks, that is the signal to refuse on rather than writing into a void. NOTE:
    // this count includes ordinary UI chrome (buttons, icons) that is legitimately
    // contenteditable="false" and is NOT evidence of a locked page on its own — see the samples.
    contentEditableFalseCount: all('[contenteditable="false"]').length,
    contentEditableFalseSamples: all('[contenteditable="false"]').slice(0, 8).map(describe),
    // Matches "locked"/"read-only" as WHOLE words — "lock" alone would false-positive on
    // "block", which is everywhere in Notion's own DOM and UI copy.
    lockishLabels: all("[aria-label]")
      .map((el) => cap(el.getAttribute("aria-label"), 60))
      .filter((l) => /\blocked\b|\bread-only\b|\bread only\b/i.test(l)),
    bodyMentionsLocked: /page is locked/i.test(cap(doc.body.textContent, 4000)),
  };

  // --- R4: the insertion experiment (WRITES — opt-in only) ---
  //
  // REVISED after the first read-only pass: R1 found only TWO contenteditable="true" elements
  // on the whole page (the icon/cover/comment header, and the title) — NO content block is
  // statically contenteditable. R5 found the reason why an append doesn't need one: Notion
  // renders its own "add a block after this" affordance as a real, labelled control
  // (role="button", aria-label starting "Click to add below"). So the append path is: find
  // THAT button the same default-deny way gmailScript finds Send (role + accessible name,
  // refuse on zero or many), click it, and see what becomes editable as a RESULT — rather than
  // us guessing at caret placement inside a block that isn't editable until Notion decides it
  // is. This also means the append-only invariant is structural here, not just a promise: the
  // button IS "add new content after the end", so there is nothing existing to accidentally
  // select or overwrite in the first place.
  if (probeInsert) {
    const marker = "M11-RECON-" + String(Date.now());
    const buttons = all('[role="button"][aria-label]').filter((el) =>
      /^click to add below/i.test((el.getAttribute("aria-label") ?? "").trim()),
    );
    if (buttons.length !== 1) {
      out.R4_insert = { skipped: `append button: found ${buttons.length}, need exactly 1` };
    } else {
      const blockCountBefore = blocks.length;
      const editableCountBefore = editables.length;
      buttons[0].click();
      // Notion creates and focuses the new block asynchronously; give it a moment.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const editableCountAfterClick = all('[contenteditable="true"]').length;
      const active = doc.activeElement;
      const execOk =
        typeof doc.execCommand === "function"
          ? doc.execCommand("insertText", false, marker + " line one\nline two")
          : null;
      await new Promise((resolve) => setTimeout(resolve, 200));

      out.R4_insert = {
        marker,
        blockCountBefore,
        editableCountBefore,
        editableCountAfterClick, // did clicking the button create a NEW contenteditable node?
        activeElementAfterClick: describe(active),
        execCommandInsertText: execOk,
        activeElementTextAfterInsert: active === null ? null : cap(active.textContent, 200),
        // Did the newline become a real second block, or a literal newline inside one block?
        // This is the whole question: Gmail's compose box takes a blob, Notion's editor does not.
        blockCountAfter: doc.querySelectorAll("[data-block-id]").length,
        note: "Compare blockCountAfter with blockCountBefore. blockCountAfter > blockCountBefore ⇒ the click alone created a block; a further jump after insertText ⇒ the newline created ANOTHER one.",
      };
    }
  }

  return out;
}

// --- CDP plumbing (minimal; CdpClient.ts is the real one, this is a throwaway) ---

async function evaluateIn(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("timed out connecting"));
    }, 10_000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out evaluating")), 15_000);
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString("utf8"));
        if (msg.id !== 1) return;
        clearTimeout(timer);
        if (msg.error) return reject(new Error(msg.error.message));
        const ex = msg.result?.exceptionDetails?.text;
        if (ex !== undefined) return reject(new Error(ex));
        resolve(msg.result?.result?.value);
      });
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
  } finally {
    socket.close();
  }
}

// --- main ---

async function main() {
  let targets;
  try {
    const res = await fetch(`${BASE_URL}/json/list`);
    targets = await res.json();
  } catch (error) {
    console.error(
      `Couldn't reach Chrome at ${BASE_URL}. Start it with --remote-debugging-port and a ` +
        `dedicated --user-data-dir, then try again. (${error.message})`,
    );
    process.exit(1);
  }

  const pages = targets.filter((t) => t.type === "page");
  const notion = pages.filter((t) => {
    try {
      return NOTION_HOST.test(new URL(t.url).hostname);
    } catch {
      return false;
    }
  });

  console.log(`Chrome at ${BASE_URL}: ${pages.length} page tab(s), ${notion.length} on a Notion host.`);
  for (const t of pages) console.log(`  ${notion.includes(t) ? "→" : " "} ${t.url}`);

  if (notion.length === 0) {
    console.error("\nNo Notion tab found. Open a THROWAWAY Notion page in that Chrome and re-run.");
    process.exit(1);
  }
  if (PROBE_INSERT) {
    console.log("\n*** --probe-insert is ON: this WILL write marker text into the page. ***");
  }

  const expression = `(${notionRecon.toString()})(document, ${PROBE_INSERT ? "true" : "false"})`;
  const dump = { capturedAt: new Date().toISOString(), baseUrl: BASE_URL, probeInsert: PROBE_INSERT, tabs: [] };

  // Every Notion tab, not just one — R6 (does visibilityState separate foreground from
  // background?) is only answerable by comparing tabs against each other.
  for (const target of notion) {
    try {
      dump.tabs.push({ url: target.url, title: target.title, recon: await evaluateIn(target, expression) });
    } catch (error) {
      dump.tabs.push({ url: target.url, title: target.title, error: error.message });
    }
  }

  writeFileSync(OUT_FILE, JSON.stringify(dump, null, 2), "utf8");
  console.log(`\nWrote ${OUT_FILE}`);

  for (const tab of dump.tabs) {
    if (tab.error !== undefined) {
      console.log(`\n${tab.url}\n  ERROR: ${tab.error}`);
      continue;
    }
    const r = tab.recon;
    const roles = Object.entries(r.R1_editor.rolesPresentOnPage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, v]) => `${k}×${v}`)
      .join(", ");
    console.log(
      `\n${tab.url}` +
        `\n  visibility=${r.page.visibilityState} hasFocus=${r.page.hasFocus}` +
        `\n  contenteditable elements: ${r.R1_editor.contentEditableCount}` +
        `\n  [data-block-id] blocks:   ${r.R3_blocks.count}` +
        `\n  contenteditable="false":  ${r.R7_locked.contentEditableFalseCount}` +
        `\n  roles on page:            ${roles.length > 0 ? roles : "(none)"}`,
    );
    if (r.R4_insert !== undefined) console.log(`  R4 insert: ${JSON.stringify(r.R4_insert)}`);
  }

  console.log(
    "\nNext: transcribe the fixture in tests/notionScript.test.ts from this dump — " +
      "do not hand-author it.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
