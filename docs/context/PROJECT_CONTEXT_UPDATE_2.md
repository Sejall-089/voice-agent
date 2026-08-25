# Project Context — Update 2 (research phase, no code changes)

Read alongside `PROJECT_CONTEXT.md`, `PROJECT_CONTEXT_UPDATE.md`, `spec.md`,
`ARCHITECTURE.md`. Nothing in this update changed any code — this is research
that happened while scoping the next feature (instruction-driven reply/compose,
see Update 1's "Open feature under discussion" section).

## Where the scoping conversation is

User wants to dig into the **full auto-click approach** for the reply/compose
feature: app auto-grabs email content (no manual select/copy), auto-clicks
"Reply" to open the compose box, drafts + auto-pastes the reply, allows
voice-driven iterative tweaks, and optionally sends via voice too.

This was explicitly named as the harder, higher-risk option vs. the "middle
ground" proposed earlier (user manually clicks Reply and Send; everything
between is automated). **No decision has been made yet** — still open.

## Research done on full auto-click (Heyclicky / Clicky ecosystem)

**Heyclicky** (the closed-source, funded product) — confirmed: screenshot-based
vision (not text extraction), voice via AssemblyAI/GPT-Realtime + ElevenLabs,
can click things and spawn autonomous background agents, integrates Gmail/
Notion/Reminders (likely via real APIs for those, not UI-clicking — reasoned,
not confirmed), YC-backed, $10.1M raised. Its own critique in the wild: "no
real moat — thin client over commodity model APIs."

**farzaa/clicky** (Heyclicky's open-source prototype, MIT-licensed, ~5-7k stars)
— confirmed via GitHub/DeepWiki: this version **only points, does not click**.
Architecture: ScreenCaptureKit screenshot → sent to Claude with vision → Claude
replies with text + coordinate tags → animated cursor flies to point at the UI
element → ElevenLabs speaks the explanation → **user clicks it themselves**.
Backend is a Cloudflare Worker proxy holding the API keys (Anthropic,
AssemblyAI, ElevenLabs) so the Swift client never embeds secrets. The actual
clicking + background-agent capability is only in the closed paid product —
publicly unverifiable.

**Key finding — an open-source project that DOES actually click exists:**
`Raynan00/clacky` — https://github.com/Raynan00/clacky — a Windows port of
Clicky that goes further: "acts — opens apps, clicks, types, runs multi-step
tasks, using Claude Computer Use." This is a real, readable reference
implementation for the full-auto-click approach (unlike Heyclicky's closed
version). Caveat: it's a solo/hobby port, not proven at production reliability
— worth reading as a study reference, not evidence the approach is safe/solid.
**Not yet actually opened/read in depth — next step if pursuing this path.**

**Other forks found, all "point only" (same safe pattern as original):**
`emreyilmaz46/clicky_windows`, `tekram/clicky-windows`,
`Bitshank-2338/clicky-windows` (fully offline via Ollama, no API key), `Flicky`
(Electron, cross-platform). None of these click on their own.

**Adjacent finds, different approach entirely (not screen-vision):**
- `per-simmons/voice-os` — https://github.com/per-simmons/voice-os — voice-
  activated, acts on a Mac, but uses the **macOS accessibility tree, not
  screenshots**, to find/act on UI elements (the more reliable pattern flagged
  earlier in this project's own research, back when comparing vision vs.
  accessibility-tree approaches). Small/demo-scale, Mac-only, not production
  quality — but architecturally the closer match to what this project would
  want if it ever goes the accessibility-tree route on Windows (UI Automation
  is the Windows equivalent).
- The "VoiceOS" commercial product referenced earlier (compared to Clicky,
  does cross-app voice-to-action via Slack/Gmail/Calendar/Notion/Drive/Docs/
  Sheets) — **could not find a public repo; likely not open source.** A
  different project by the same name (OpenVoiceOS, for embedded/Raspberry Pi
  devices) exists and is unrelated — don't confuse the two.

## The reframed decision (informed by the research above)

Three real options now on the table for the reply/compose feature, in order of
risk:
1. **Point-and-explain, user clicks** — provably real (the actual open-source
   Clicky pattern), lowest risk, matches this project's existing reliability
   discipline. Not yet attempted as a feature here.
2. **Middle ground** (proposed earlier, still standing) — user manually opens
   Reply and hits Send; app auto-drafts, auto-pastes into the now-focused box,
   handles voice-driven tweaks in between. No screen-clicking needed at all.
3. **Full auto-click** — user's stated interest. Real open-source reference now
   exists (`clacky`) but is unverified at scale, and still carries every
   problem flagged earlier: slow (multiple AI calls per click), fragile (UI
   changes break it), untestable the way the rest of this project's tools are
   tested, and higher-stakes when wrong (especially auto-send). Would be a
   genuinely new capability class for this project, not an incremental feature.

**Not yet decided. This is the first thing to resolve in the next chat before
writing any Plan Mode prompt for the reply/compose feature.**

## Carry forward into next chat
- Resolve the three-option decision above before scoping the actual milestone.
- If pursuing option 3, read `Raynan00/clacky`'s code structure first (not yet
  done) — specifically how it uses Claude Computer Use, what safety/confirm
  pattern (if any) it has around clicking, before designing this project's own
  version.
- Whatever option is picked, it becomes a new milestone: Plan Mode first
  (Opus, high effort — genuine new design surface either way), then mechanical
  implementation (Sonnet, standard) once scoped.
