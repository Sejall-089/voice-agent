// Shared contracts for the core brain. Everything the planner, registry, tools, LLM,
// memory, and action log agree on lives here so there are no import cycles.
//
// /core is OS-agnostic: it imports the OSShell contract TYPE-ONLY (OSShell.ts has no
// electron import), which keeps /core free of electron per spec.md §10.
import type {
  CapturedContext,
  LocalAction,
  OSShell,
} from "../main/shell/OSShell.ts";
import type { DraftStore } from "./draft.ts";
import type { SpokenText } from "./speech.ts";
import type { SpeechStore } from "./speechStore.ts";
import type { Risk, ToolRisk } from "./risk.ts";

export type { CapturedContext, LocalAction };
// Re-exported so a tool can name its own tier without reaching past this file for one type.
export type { Risk };

// --- Tool schemas (what the LLM sees) ---

// A minimal JSON Schema for a tool's input object. Kept typed (no `any`).
export interface JSONSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

// The public description of a tool, shown to the LLM for tool-calling.
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

// Arguments the LLM proposes for a tool call.
export type ToolInput = Record<string, unknown>;

// --- The LLM behind an interface (real: Anthropic; test: a fake) ---

// One step of a chained plan (M17) — a tool the model has already committed to, in a fixed
// position, with the arguments it proposed for that position.
//
// `arguments` is NOT the final input. A string argument may carry a `{stepN}` placeholder,
// substituted with step N's real result by `core/chain.ts` at the moment execution reaches this
// step — after the steps before it have actually run, and before this step's own gate fires.
// That ordering is the whole safety property: the user is never asked to approve an argument
// that was guessed, and the model is never consulted again once the plan is fixed.
export interface PlannedStep {
  tool: string;
  arguments: ToolInput;
  // A short phrase for the plan preview ("add it to your Notion page"). Model-authored TEXT,
  // never a model-authored action — it is displayed and spoken, and nothing reads it back.
  // Deliberately allowed to be vaguer than the eventual real action, because a later step's
  // real argument is not known yet when the plan is narrated.
  describe: string;
}

export type ToolChoice =
  | { kind: "tool"; name: string; input: ToolInput }
  // Several tools, in a fixed order, from ONE planning call (M17). Not an agent loop: the model
  // decides the whole sequence here and is never asked again, so the step count is known before
  // anything runs and every step is gated by the same per-tool machinery a single call is.
  //
  // A separate variant rather than a one-element-or-many `tool`, because the single-step path is
  // the overwhelmingly common one and must stay exactly what it was — a chain narrates itself
  // up front and can stop half-finished, and neither of those should be reachable by an
  // instruction that only ever meant one action.
  | { kind: "plan"; steps: PlannedStep[] }
  | { kind: "none"; text: string | null }
  // The model never reached an answer — it hit its token ceiling first. Distinct from
  // "none" on purpose: "I decline" and "I ran out of room" are different facts, and
  // collapsing them makes a budget failure look like a missing capability. Reasoning
  // models spend from the same budget the tool call has to fit in, so this is reachable.
  | { kind: "incomplete"; reason: string };

export interface LLMClient {
  // Pick one tool from the menu (or decline). `previousTurn` is the single most recent
  // logged action (or null) — the one piece of state the planner carries between
  // instructions, so a bare correction ("no, I meant...") has something to resolve against.
  chooseTool(
    instruction: string,
    context: CapturedContext,
    tools: ToolSchema[],
    previousTurn: ActionLogEntry | null,
  ): Promise<ToolChoice>;
  // Free-form generation used inside tool handlers (e.g. summarize).
  complete(system: string, user: string): Promise<string>;
}

// --- The one external connector (spec §2), behind an interface like LLMClient ---

export interface SendResult {
  ok: boolean;
  error?: string;
}

export interface MessageSender {
  send(channel: string, text: string): Promise<SendResult>;
}

// --- Speech to text, behind an interface like LLMClient / MessageSender (M7) ---

// A captured recording, already in the one format the transcriber wants: 16 kHz mono
// 16-bit PCM WAV. Normalizing at the capture site (the renderer) keeps every Transcriber
// implementation free of resampling concerns.
export interface AudioClip {
  wav: Uint8Array;
  durationMs: number;
}

export interface Transcriber {
  // Speech → text. Throws (never returns a sentinel) when transcription fails; returns
  // an empty string when the audio held no speech.
  transcribe(clip: AudioClip): Promise<string>;
}

// --- Text to speech, behind an interface like Transcriber (M14) ---

export interface SpeechSynthesizer {
  // Text → one utterance as WAV bytes, header included. Throws (never returns a sentinel) when
  // synthesis fails — including on empty input, which the real engine exits non-zero on rather
  // than treating as silence.
  //
  // Deliberately NOT an AudioClip. That type's contract is "16 kHz mono, the one format the
  // transcriber wants", and Piper's medium voices are 22.05 kHz; reusing it would be a lie
  // about the shape of the thing. The WAV header carries the rate, so the player can just read
  // it, and a future ElevenLabs implementation returns whatever IT produces without either side
  // pretending to be the microphone path.
  synthesize(text: string): Promise<Uint8Array>;
}

// --- The browser surface (M10), behind an interface like MessageSender / Transcriber ---

// One email as the app sees it. Deliberately flat and app-neutral: nothing here says "Gmail",
// so the writing side (core/compose.ts) never learns which client the message came out of.
export interface EmailMessage {
  subject: string | null;
  from: string | null;
  fromName: string | null;
  to: string | null;
  body: string;
}

// Acting inside a live Gmail tab, split by what each operation costs if it goes wrong — the
// tiers in core/risk.ts. Implementations must fail loudly rather than guess: every method here
// either does exactly the named thing or throws with a human-readable reason.
export interface GmailSurface {
  readOpenEmail(): Promise<EmailMessage>; // SAFE — read-only
  openReplyBox(): Promise<void>; // CAUTION — no undo, low stakes
  readComposeText(): Promise<string | null>; // SAFE — null when no compose box is open
  // SAFE. Read from the COMPOSE box, not from the original email: the confirm dialog must name
  // who the reply will actually reach, which is not always who wrote to you.
  readComposeRecipients(): Promise<string | null>;
  setComposeText(text: string): Promise<void>; // CAUTION
  // DANGEROUS. The planner's confirm gate is the only thing that may lead here — no handler
  // calls this without having passed it.
  clickSend(): Promise<void>;
}

// --- The Notion surface (M11), behind an interface like GmailSurface ---

// One Notion page as the app sees it. Deliberately flat, like EmailMessage: nothing here says
// "Chrome" or "CDP", so the writing side (core/composeNote.ts) never learns which browser
// layer the page came out of.
export interface NotionPage {
  title: string | null;
  url: string;
  body: string;
}

// Acting inside a live Notion tab. Two methods, not six — the narrowness IS M11's finding:
// Notion has no staging area and no send action, so there is nothing corresponding to
// GmailSurface's openReplyBox/readComposeText/readComposeRecipients/clickSend. Appending is
// the only mutation this app gets a safe, honest shape for (core/risk.ts's `caution` tier;
// core/notion/notionScript.ts's append-only invariant).
export interface NotionSurface {
  readOpenPage(): Promise<NotionPage>; // SAFE — read-only
  // CAUTION. Appends only — MUST NEVER replace, delete, or reorder anything already on the
  // page. That is the one rule notionScript.ts exists to enforce.
  appendToPage(text: string): Promise<void>;
}

// --- The calendar surface (M13), behind an interface like GmailSurface / NotionSurface ---

// One calendar event as the app sees it. Flat and vendor-neutral, like EmailMessage and
// NotionPage: nothing here says "Google", so the tools never learn whose API it came out of.
//
// This is also the first surface that is an API rather than a browser. That is not a change of
// principle — it is the same reasoning that made Slack an API: there is no live, editable draft
// box to put words in, only structured data, so there is nothing a DOM would buy.
export interface CalendarEvent {
  id: string;
  title: string;
  // ISO instant with offset for a timed event; YYYY-MM-DD when `allDay`.
  start: string;
  // For an all-day event this is the INCLUSIVE last day. Google's wire format makes it
  // exclusive (a one-day event on the 26th ends on the 27th); that is normalized away at the
  // mapping boundary so this field means one thing everywhere above it.
  end: string;
  allDay: boolean;
  // OTHER people's email addresses — never the user's own. This is what decides the risk tier
  // of createEvent/moveEvent, so it has to mean "who would be emailed about this", not "who is
  // listed on it". Google includes the organizer in its own attendee list, so a naive mapping
  // would make every solo event look like it had a guest and quietly gate everything.
  attendees: string[];
  // An instance of a recurring series. M13 REFUSES to move one — instance-vs-series is a real
  // choice with a real wrong answer, and guessing it is worse than declining.
  recurring: boolean;
}

// What createEvent asks for. No `allDay`: M13 writes timed events only, so `start`/`end` are
// always ISO instants here. Reading handles all-day events; writing declines them (spec §6c).
export interface EventDraft {
  title: string;
  start: string;
  end: string;
  attendees: string[];
}

// Acting on the user's primary calendar. Every method either does exactly the named thing or
// throws with a human-readable reason — same contract as GmailSurface and NotionSurface.
//
// The tiers on the two writing methods are NOT fixed: they depend on whether that particular
// event has guests (core/risk.ts's RiskPolicy). Both read methods exist partly to answer that
// question before anything is gated.
export interface CalendarSurface {
  // SAFE. The calendar's OWN timezone, used to display times the way the user sees them in
  // Google Calendar. Not the same thing as the user's local zone, which is what the planner
  // prompt carries (spec §5) — usually identical, never assumed to be.
  calendarTimeZone(): Promise<string>;
  listUpcoming(from: string, to: string, limit: number): Promise<CalendarEvent[]>; // SAFE
  // SAFE. Zero or many matches is not an answer — the caller REFUSES rather than picking one,
  // the same default-deny rule gmailScript.ts applies to buttons.
  findEvent(query: string, from: string, to: string): Promise<CalendarEvent[]>;
  getEvent(id: string): Promise<CalendarEvent>; // SAFE
  // CAUTION with no attendees, DANGEROUS with them — there is no separate "send" step to gate,
  // because guests are emailed the moment this returns.
  createEvent(draft: EventDraft): Promise<CalendarEvent>;
  // Same split, decided by the guests on the event BEING MOVED.
  moveEvent(id: string, start: string, end: string): Promise<CalendarEvent>;
}

// --- The screen (M15), behind an interface like GmailSurface / CalendarSurface ---

// One display, in DIP (device-independent pixels) — the coordinate space the OS positions
// windows in, and therefore the space a pointer overlay has to be placed in.
//
// NOTE WHAT IS STILL DELIBERATELY ABSENT: `scaleFactor`. Recon measured this machine at
// 1280x720 DIP with a scaleFactor of 1.5, on a 1920x1080 native panel. A `scaleFactor` field
// sitting in this type would be an invitation to write `x / scaleFactor` — and M15 measured
// exactly why that is a trap: it is correct at native resolution and quietly wrong the moment
// anything is rescaled. It is left out so that bug cannot be spelled.
//
// M16 ADDS THE NATIVE PIXEL SIZE, WHICH IS NOT THE SAME CONCESSION. UI Automation reports
// `BoundingRectangle` in NATIVE PIXELS (measured — see scripts/uia-recon.ps1), and the overlay
// places windows in DIP, so a real mapping is needed between them. Carrying the two SIZES
// rather than the RATIO between them keeps the existing discipline intact: every mapping in
// this codebase is derived from the two spaces it actually spans, at the moment it is needed —
//
//     native px → DIP :  display.width / display.nativeWidth
//
// — which is the same shape as the mapping the vision path derived (`display.width /
// shot.width`). One idiom, no stored ratio to go stale, and still no way to spell the bug.
export interface DisplayBounds {
  id: number;
  // Position and size in DIP — where the overlay has to be placed.
  x: number;
  y: number;
  width: number;
  height: number;
  // The same display's true ORIGIN and SIZE in physical pixels — the space UIA answers in (M16).
  //
  // THE ORIGIN IS NOT `x * scaleFactor`, AND THAT IS THIS MILESTONE'S VERSION OF M15's TRAP.
  // On the machine everything here was measured on there is one display at DIP (0,0), so
  // `0 * 1.5 === 0` and the wrong formula passes every test that exists. It breaks on a second
  // monitor, where each display has its own scale factor and the physical origin of the one on
  // the right is NOT its DIP origin times its own scale. Same shape as M15's `x / scaleFactor`:
  // correct in the configuration it was written against, silently wrong elsewhere, and it fails
  // by putting a confident marker on the wrong screen rather than by throwing.
  //
  // So these come from the OS (`screen.dipToScreenPoint`), never from arithmetic. See
  // src/main/screen/WindowsScreen.ts.
  nativeX: number;
  nativeY: number;
  nativeWidth: number;
  nativeHeight: number;
}

// A rectangle in SCREEN DIP, as the overlay needs it.
//
// BRANDED, AND THAT IS THE POINT (M16.6). M15 gave this a separate name from `ElementBox` (deleted at M16.10) and
// argued "two names make that visible at the call site" — but a name is documentation, not
// enforcement. TypeScript is structural: `ElementBox`, `NativeRect` and this were all
// `{x,y,width,height}`, so passing any one where another belonged compiled silently. That is
// precisely the milestone's #1 expected bug, and it produced no error at all.
//
// The phantom `__dip` field cannot be forged by a literal, so the ONLY way to obtain a
// `ScreenRect` is through `core/screen/geometry.ts`'s `toScreenRect`. Handing UIA's native
// pixels straight to the overlay — the exact 1.5x mistake — is now a compile error rather than
// a marker in the wrong place. Nothing reads the field at runtime; it does not exist there.
declare const DIP_BRAND: unique symbol;

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
  readonly [DIP_BRAND]: never;
}

export interface PointerTarget {
  rect: ScreenRect;
  // What the app believes it is pointing at, shown beside the marker. The user's own check on
  // the model's answer: if the label says "Send" and the marker is on "Discard", they can see
  // that before clicking anything.
  label: string;
}

// Drawing on the screen, and knowing which display a rectangle falls on. Implemented in `/main`
// (it needs electron) but DECLARED here, because it is a dependency a tool reaches through
// `ToolDeps` — the GmailSurface/NotionSurface/CalendarSurface shape.
//
// IT NO LONGER CAPTURES ANYTHING (M16.10). `capture()` existed for one caller — the vision
// grounding this milestone replaced — and went with it. What is left is the overlay and the
// display lookup that feeds the coordinate conversion. `setContentProtection` stays on the
// overlay window regardless: it is what stops one marker appearing in a screenshot some OTHER
// application takes, which was never a vision-specific concern.
export interface ScreenSurface {
  // REVERSIBLE. Draw the marker. It NEVER clicks, never moves the real cursor, and never
  // takes focus — the whole premise of this milestone is that the human is the one who clicks.
  point(target: PointerTarget): Promise<void>;
  // Take it away. Safe to call when nothing is showing, and safe to call twice.
  clearPointer(): void;
  // SAFE. Which display does this NATIVE-pixel rectangle fall on, and what are its two
  // coordinate spaces? (M16)
  //
  // The lookup lives behind the surface because it needs the OS, but the CONVERSION it feeds
  // stays in `/core` where it is testable — the opposite of the tempting arrangement, which
  // would be to hand the surface a native rect and let `/main` do the arithmetic somewhere no
  // test can reach it.
  //
  // It takes a native rect rather than returning "the current display" because on a
  // multi-monitor desktop those are different questions: the window being read may not be on
  // the display the cursor is on, and picking the wrong one puts the marker on the wrong screen.
  displayForNative(rect: NativeRect): Promise<DisplayBounds>;
}

// --- The window's controls (M16), behind an interface like GmailSurface / CalendarSurface ---
//
// THE INVERSION THIS MILESTONE EXISTS FOR. M15 asked a vision model both WHICH control the user
// meant and WHERE it is, and live testing found it answering the second question wrong in a
// specific, dangerous way: not imprecise, but the wrong control entirely — one tab over on a tab
// label, ~208px onto a neighbouring icon on a toolbar. That is the one place in this codebase
// where "the LLM proposes, the planner disposes" was broken, and no amount of prompt or
// threshold tuning closes it (published 2026 benchmarks put the strongest models near 31% strict
// point-in-box accuracy against ~97% human, worst on exactly the small, dense targets a desktop
// is made of).
//
// So coordinates stop coming from the model. UI Automation enumerates the window's controls with
// EXACT rects; code filters and numbers them; the model's entire output surface is one integer.
// An integer cannot be off by 208 pixels. It can be the WRONG integer — a semantic error, which
// is the error class models are actually good at, and one the user can see in the label drawn
// beside the marker.

// A rectangle in NATIVE SCREEN PIXELS, as UI Automation reports `BoundingRectangle`.
//
// A third rect type, and deliberately its own name rather than a reuse of `ScreenRect`
// (DIP, what the overlay wants) or the deleted `ElementBox` (image pixels, the vision path's).
// M15 made this call first and it was the right one: the entire expected class of bug here is
// one rect type being passed where another belongs, and separate names make that visible at the
// call site instead of at the moment a marker lands 1.5x away from the button.
export interface NativeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// One control, exactly as UIA describes it — transcribed, not interpreted.
//
// `offscreen` is carried even though it is also used as a filter, because it is NOT sufficient
// on its own: recon measured a MINIMIZED Notepad reporting `IsOffscreen = false` on all 39 of
// its elements, with rects around (-31991, -31890). Anything reading this field needs the
// window rect too. See core/screen/elements.ts.
export interface UiElement {
  // UIA's `Name`. The property the model does its matching against; empty for a great many
  // elements, which is why the filter drops them rather than trying to invent one.
  name: string;
  // `ControlType.ProgrammaticName` with the "ControlType." prefix stripped: "Button",
  // "MenuItem", "TabItem", "Group"... Reported to the model as context, never used to exclude —
  // recon found VS Code's activity-bar icons are `Group`, not `Button`, so a control-type
  // allowlist drops real targets.
  controlType: string;
  rect: NativeRect;
  enabled: boolean;
  offscreen: boolean;
  focusable: boolean;
  // UIA's `AutomationId` — stable across locales where `Name` is not. Carried for diagnostics
  // and for future disambiguation; not currently shown to the model.
  automationId: string;
}

// One enumeration of one window, at one moment.
//
// Scoped to a SINGLE window rather than the desktop, which is what keeps the candidate list at
// the 26-97 entries recon measured, and what keeps names unambiguous — "New" is a Notepad tab
// AND an Explorer button, but within one window it is neither.
export interface WindowElements {
  windowTitle: string;
  // Win32 class name. Load-bearing, not diagnostic: it is trigger A of the settle check
  // (core/screen/settle.ts) — `Chrome_WidgetWin_1` marks the Chromium/Electron windows recon
  // measured populating their accessibility tree lazily.
  windowClass: string;
  // The window's own bounds, in native pixels. The filter intersects every element against
  // this, because `offscreen` does not catch a minimized window (see UiElement above).
  windowRect: NativeRect;
  elements: UiElement[];
}

// The cheap half of the surface: how many controls are there right now, and what kind of window
// is this? Measured at 46-80ms against full enumeration's 200-850ms, which is what makes the
// settle check in core/screen/settle.ts affordable to run inside a live "point at X" turn.
export interface WindowProbe {
  count: number;
  windowClass: string;
}

// A filtered, de-duplicated, numbered control — what the model actually sees.
export interface Candidate {
  // 1-based, and the ONLY thing the model ever answers with.
  number: number;
  name: string;
  controlType: string;
  // A coarse position phrase ("the top left"), COMPUTED BY CODE from `rect` and handed to the
  // model as context. This is what lets someone say "the button next to the address bar" and be
  // understood — the model READS position and never REPORTS it, which is the whole inversion in
  // one field.
  position: string;
  // Whether the control can actually be used right now (M16.11).
  //
  // Disabled controls are KEPT as candidates rather than filtered out, and that is a change of
  // mind with a live finding behind it. They used to be dropped, which meant asking for a
  // greyed-out button produced "I couldn't find it among the 70 controls I can see" — a sentence
  // that says the thing is not there, when it is there and simply cannot be clicked. Two
  // different facts deserve two different answers; the model needs to see the control to tell
  // them apart, and the gate refuses on this flag afterwards.
  enabled: boolean;
  // Never shown to the model. Resolved by code once a number comes back.
  rect: NativeRect;
}

// Which candidate did they mean? Three outcomes for the same reason M15's `LocateResult` had three and
// `ToolChoice` has three: "that one", "none of these", and "several of these" are different
// facts, and collapsing them loses the one thing the user needs to hear.
//
// Note what is NOT here: any coordinate. The type makes the safety property structural rather
// than something a validator has to enforce after the fact.
export type ChoiceResult =
  | { kind: "picked"; number: number }
  | { kind: "none" }
  | { kind: "ambiguous"; numbers: number[] };

// Reading the controls of the window the user was looking at. Implemented in `/main` (it needs
// PowerShell and UI Automation) but DECLARED here, exactly like `ScreenSurface` — it is a
// dependency a tool reaches through `ToolDeps`, so it is a surface, not a shell.
//
// Neither method takes a window: the implementation resolves the target itself, from the
// foreground-window snapshot taken BEFORE the command bar stole focus. Same shape as
// `ScreenSurface.capture()` picking its own display, and it keeps `/core` free of HWNDs.
// Is the window we read still the one the user is looking at? (M16.9)
export interface TargetCheck {
  // False when the user has switched to a THIRD application — not the target, and not this app's
  // own bar, which necessarily holds focus for the whole call.
  stillCurrent: boolean;
  // The target window's bounds re-read now. A window that has been dragged or resized since the
  // enumerate invalidates every rect that came out of it.
  rect: NativeRect;
}

export interface ElementSurface {
  // SAFE. The cheap count-only read, for the settle check.
  probe(): Promise<WindowProbe>;
  // SAFE. Re-read just enough to know whether the answer is still about the right window.
  verifyTarget(): Promise<TargetCheck>;
  // SAFE. Everything pointable in the target window. Reads only; never invokes a control.
  enumerate(): Promise<WindowElements>;
}

// Which of these did they mean? Its own interface rather than a widening of `LLMClient`, for the
// reason that kept M15's `VisionLocator` separate: that interface is about language in general, and
// this is one bounded question with its own return type and its own failure modes.
//
// The implementation never decides an ACTION and never produces a coordinate — it picks from a
// list it was handed, and core/screen/ validates the answer is even in range before anything is
// drawn.
export interface ElementChooser {
  // `windowTitle` is context for the model, not decoration: "the new button" means something
  // different in File Explorer than in a mail client. It is already on screen in front of the
  // user, so it discloses nothing the request does not already imply.
  choose(
    candidates: readonly Candidate[],
    target: string,
    windowTitle: string,
  ): Promise<ChoiceResult>;
}

// --- Memory resolve seam (M1 no-op; M3 becomes SQLite-backed) ---

export interface MemoryResolver {
  // Replace vague argument references with concrete values. M1: returns input unchanged.
  resolveArgs(input: ToolInput): Promise<ToolInput>;
}

// A stored fact with its epistemic metadata (spec.md §7).
export interface Fact {
  id: number;
  subject: string;
  value: string;
  confidence: number;
  source: string | null;
  version: number;
  active: number; // 0 when superseded
  created_at: string;
  updated_at: string;
}

export interface ResolvedFact {
  value: string;
  confidence: number;
}

export interface WriteOptions {
  confidence?: number;
  source?: string;
}

// The full memory engine (spec.md §7). It IS a MemoryResolver, so it drops straight into
// the planner's existing seam — the planner never learns memory got smarter.
export interface Memory extends MemoryResolver {
  resolve(reference: string): ResolvedFact | null;
  write(subject: string, value: string, opts?: WriteOptions): void;
  query(subjectLike: string): Fact[];
}

// --- Tools ---

// Dependencies handed to every tool handler (injected, never global — spec §10).
export interface ToolDeps {
  context: CapturedContext;
  llm: LLMClient;
  shell: OSShell;
  memory: Memory;
  sender: MessageSender;
  // M10 / M11. Both have "unavailable"/empty defaults at the planner, so a tool can never
  // reach a browser the app was not configured to drive.
  gmail: GmailSurface;
  notion: NotionSurface;
  draft: DraftStore;
  // M13. Same idea again — an unconnected default, so a tool can never reach a calendar the
  // app was not configured to use.
  calendar: CalendarSurface;
  // M14. What the app held back the last time it spoke a summary instead of the whole thing.
  // Scratch state owned by the planner (one per app run), handed down like `draft` — see
  // core/speechStore.ts for why it deliberately never reaches SQLite.
  speech: SpeechStore;
  // M15/M16. Drawing on the screen. Same "unavailable default" rule as every surface above.
  screen: ScreenSurface;
  // M16. The controls of the window the user was looking at, with exact rects. Same
  // "unavailable default" rule as every surface above: a tool can never reach a window the app
  // was not configured to read.
  elements: ElementSurface;
  // M16. Which of those controls did they mean? Separate from `elements` because reading a
  // window and asking a model about it are different capabilities that fail differently — the
  // same split `screen` and `vision` already have.
  chooser: ElementChooser;
  // M16. Injected so the settle loop's delays are a dependency rather than a wall-clock fact —
  // tests advance it instantly, and `core/screen/settle.ts` stays a pure decision with the
  // waiting done out here. Same reasoning as every other seam in this bundle: the thing that
  // would otherwise be untestable is the thing that gets injected.
  sleep: (ms: number) => Promise<void>;
  // What tier THIS call resolved to (core/risk.ts). `null` only inside a `RiskPolicy.resolve`,
  // which is the thing that decides it and therefore runs before it exists; by the time
  // `narrate`, `confirmSummary` or the handler sees it, it is always set.
  //
  // A handler needs this for one specific job: a tier decided by reading the world can go stale
  // between the reading and the acting. `moveEvent` classifies an event as guest-free, and a
  // second later someone else adds a guest to it — without this, the handler would email a
  // person the user was never asked about. Knowing the tier lets it refuse instead.
  tier: Risk | null;
}

// A handler returns the text to display; it throws on failure (planner catches).
// Side effects (clipboard, open URL, Slack) are performed via deps.shell.executeAction.
export type ToolHandler = (input: ToolInput, deps: ToolDeps) => Promise<string>;

export interface Tool extends ToolSchema {
  // What this tool costs if it goes wrong (M10, core/risk.ts). Replaced the earlier
  // `irreversible: boolean` — see that file for why a boolean stopped being enough once tools
  // could act inside another app's GUI. The planner reads it generically: it never knows which
  // tool it is gating.
  //
  // Usually a plain tier, exactly as it has been since M10. M13 widened it to allow a
  // `RiskPolicy` — a tool whose cost depends on the ARGUMENTS of the particular call rather
  // than on the tool itself (a calendar event with guests emails them; the same event without
  // guests touches nobody). See core/risk.ts for why calendar needed this and Gmail did not.
  risk: ToolRisk<ToolInput, ToolDeps>;
  handler: ToolHandler;
  // Whether the planner should run this tool's args through memory's reference resolution.
  // Defaults to true. Memory-WRITING tools set this false: their args are literals to store
  // ("the team" is the subject to write, not a reference to look up), so resolving them would
  // silently replace the subject with the fact's current value.
  resolvesReferences?: boolean;
  // How to describe this action to the user at the confirm gate. The planner calls this with the
  // RESOLVED args, so the user always approves the concrete action ("Send to #design-team?"),
  // never the vague one they typed ("send to the team"). `dangerous` tools should define it.
  //
  // It also gets `deps`, and may be async, so a GUI action can describe what is ACTUALLY there
  // — the real recipient chips, the real text in the reply box — instead of the arguments the
  // model guessed. Read-only (SAFE, core/risk.ts) work only: this runs BEFORE the user has
  // agreed to anything, so it must never change the world it is describing. If it throws, the
  // planner treats that as "we can't say what would happen" and nothing runs.
  confirmSummary?: (
    args: ToolInput,
    deps: ToolDeps,
  ) => string | Promise<string>;
  // What to tell the user BEFORE a `caution` tool acts. Same shape and same reasoning as
  // confirmSummary — built from the resolved args — but it announces rather than asks, because
  // a caution action runs on its own. Narration is what stands in for the undo that doesn't exist.
  //
  // Widened in M11, the same way confirmSummary widened in M10 and for the identical reason:
  // a GUI action's concrete facts — which Notion page this would write to, say — live in the
  // app being acted on, not in the arguments the model proposed, so narration that could not
  // read them would be announcing a guess. It may do SAFE work only: it runs before the tool
  // acts, so it must never change the world it is describing. If it throws, the planner treats
  // that as "we can't say what we're about to do" and nothing runs — same as confirmSummary.
  narrate?: (args: ToolInput, deps: ToolDeps) => string | Promise<string>;
  // How to SAY this tool's result (M14). The fourth optional hook, and the same shape and
  // reasoning as `narrate` and `confirmSummary`: the planner asks the tool how to describe
  // itself and never learns which tool it is asking.
  //
  // Optional because the default is good: `core/speech.ts` derives a spoken line from the
  // displayed result generically, and most tools return one short sentence that needs nothing
  // else. A tool defines this only when the generic derivation would say something a person
  // would not — `readSchedule`'s formatted list is the case that justified the hook, because
  // the generic head-of-list reads attendees' email addresses out loud, character by
  // character, and there is no fixing that from outside the tool that knows they are addresses.
  //
  // Takes the result the handler already produced rather than re-deriving from the world: the
  // spoken and displayed versions must describe the same answer, and a second read of a
  // calendar could legitimately return something different.
  speakResult?: (
    result: string,
    args: ToolInput,
    deps: ToolDeps,
  ) => SpokenText | Promise<SpokenText>;
}

// --- Action log seam (M1 in-memory; M3 becomes SQLite action_log) ---

export type ActionStatus = "ok" | "refused" | "no_tool" | "error" | "cancelled";

export interface ActionLogEntry {
  ts: string;
  instruction: string;
  tool: string | null; // null when no tool matched
  arguments: ToolInput | null;
  result: string | null;
  status: ActionStatus;
}

export interface ActionLog {
  logAction(entry: ActionLogEntry): void;
  logMiss(instruction: string): void; // records a "no_tool" miss
  // The single most recently logged entry, or null on a fresh session — the planner's
  // one turn of state, fed back into the next chooseTool call.
  getLast(): ActionLogEntry | null;
}

// --- Planner result ---

export interface PlannerOutcome {
  status: ActionStatus;
  tool: string | null;
  result: string | null;
  // Present only for a chained run (M17), and the one fact about a chain that a caller outside
  // the planner can act on: how much of it actually happened. `runInstruction.ts` puts it on the
  // `[main]` ground-truth line, because "refused" alone cannot distinguish a plan that died on
  // step 1 from one that died on step 3 — and live testing has to be able to tell those apart.
  //
  // `completed` counts steps that ran to `ok`, so a chain that stopped at step 2 of 3 reports
  // `{ completed: 1, total: 3 }`.
  chain?: { completed: number; total: number };
}
