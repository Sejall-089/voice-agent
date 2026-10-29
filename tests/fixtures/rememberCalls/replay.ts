// Every `remember` call on record (M33), for tests/remember.overwrite.test.ts to replay through
// the real planner with no model.
//
// SOURCES.
//   - The real action log: all 12 `remember` rows (rows 14-591), read from a copy of memory.db on
//     2026-10-30. `before` is the memory as it stood one second before each row, rebuilt from the
//     fact table's versions and timestamps (a fact counts if it was created before then and was
//     still active, or was deactivated after). Writes are listed in order, superseded values
//     included, so the versions the replay reaches are the versions the app reached.
//   - M32's scripted run: the one correction that planned `remember team = social`. M32's harness
//     memory held only "third channel" = #fun (and threw its writes away); `before` here is the
//     app's memory on that day, which is what the finding is about.
//   - The scripted evals and flagship tests, whose model answers are written by hand.
//
// PRIVACY. Personal names are replaced with markers ([first name], [other name], [full name]), and
// row 591's value — a 1,481-character clipboard dump — with a marker of its length. Nothing else
// in these rows is personal: a public dashboard URL, channel names, a tone.
//
// `mode` is the Slack mode the row ran in: bot mode began with M22 (2026-10-11).
// `dialog` is M33's expectation: true exactly where the call replaces a DIFFERENT value.
// `status` and `result` are what the app recorded (results with the same markers), or, for a
// scripted answer, what that test asserts; a dialog row reaches them only when approved.

export interface RememberCall {
  id: string;
  source: "action log" | "M32 scripted run" | "scripted eval";
  instruction: string;
  arguments: { subject: string; value: string };
  mode: "webhook" | "bot";
  before: readonly (readonly [subject: string, value: string])[];
  dialog: boolean;
  status: "ok" | "refused" | "error";
  result: string;
}

const TONE = ["tone", "concise, warm, and direct"] as const;
const DASHBOARD = ["target:dashboard", "https://github.com/dashboard"] as const;
const TEAM = ["team", "#social"] as const;
const FIRST_NAME = ["name", "[first name]"] as const;
const OTHER_NAME = ["name", "[other name]"] as const;
const FULL_NAME = ["name", "[full name]"] as const;
const CHANNEL_SOCIAL = ["channel:social", "#social"] as const;
const SOCIAL_CHANNEL = ["social channel", "#social"] as const;

// Row 591's value, as a marker. The real one was a pasted prompt.
export const CLIPBOARD_MARKER = "[clipboard: 1481 chars]";

// Before row 475 (and after): the bugs channel was deactivated by hand, then answered as "help".
const OCT_12 = [
  TONE,
  DASHBOARD,
  TEAM,
  CHANNEL_SOCIAL,
  SOCIAL_CHANNEL,
  ["bugs channel", "help"],
  FIRST_NAME,
  OTHER_NAME,
  FULL_NAME,
  ["main channel", "help"],
  ["issue channel", "help"],
] as const;
const OCT_22 = [...OCT_12, ["alt channel", "#help"], ["second channel", "#help"], ["third channel", "#fun"]] as const;

export const REMEMBER_CALLS: readonly RememberCall[] = [
  // --- The real action log ---
  {
    id: "row 14",
    source: "action log",
    instruction: "remember my dashboard is https://github.com/dashboard",
    arguments: { subject: "target:dashboard", value: "https://github.com/dashboard" },
    mode: "webhook",
    before: [TONE],
    dialog: false,
    status: "ok",
    result: "Remembered: target:dashboard = https://github.com/dashboard",
  },
  {
    id: "row 21",
    source: "action log",
    instruction: "remember the team is #social",
    arguments: { subject: "team", value: "#social" },
    mode: "webhook",
    before: [TONE, DASHBOARD],
    dialog: false,
    status: "ok",
    result: "Remembered: team = #social",
  },
  {
    id: "row 81",
    source: "action log",
    instruction: "remember my name is [first name]",
    arguments: { subject: "name", value: "[first name]" },
    mode: "webhook",
    before: [TONE, DASHBOARD, TEAM],
    dialog: false,
    status: "ok",
    result: "Remembered: name = [first name]",
  },
  {
    // The unwanted overwrite: a statement that was not a correction, standing for four days.
    id: "row 323",
    source: "action log",
    instruction: "Hello my name is [other name]. I'm...",
    arguments: { subject: "name", value: "[other name]" },
    mode: "webhook",
    before: [TONE, DASHBOARD, TEAM, FIRST_NAME],
    dialog: true,
    status: "ok",
    result: 'Updated "name": [first name] → [other name] (v2).',
  },
  {
    id: "row 350",
    source: "action log",
    instruction: "remember the social channel is #social",
    arguments: { subject: "channel:social", value: "#social" },
    mode: "webhook",
    before: [TONE, DASHBOARD, TEAM, FIRST_NAME, OTHER_NAME],
    dialog: false,
    status: "ok",
    result: "Remembered: channel:social = #social",
  },
  {
    id: "row 354",
    source: "action log",
    instruction: "remember the social channel is #social",
    arguments: { subject: "social channel", value: "#social" },
    mode: "webhook",
    before: [TONE, DASHBOARD, TEAM, FIRST_NAME, OTHER_NAME, CHANNEL_SOCIAL],
    dialog: false,
    status: "ok",
    result: "Remembered: social channel = #social",
  },
  {
    id: "row 388",
    source: "action log",
    instruction: "remember the bugs channel is #your-real-channel",
    arguments: { subject: "bugs channel", value: "#your-real-channel" },
    mode: "webhook",
    before: [TONE, DASHBOARD, TEAM, FIRST_NAME, OTHER_NAME, CHANNEL_SOCIAL, SOCIAL_CHANNEL],
    dialog: false,
    status: "ok",
    result: "Remembered: bugs channel = #your-real-channel",
  },
  {
    id: "row 389",
    source: "action log",
    instruction: "remember the bugs channel is #social",
    arguments: { subject: "bugs channel", value: "#social" },
    mode: "webhook",
    before: [TONE, DASHBOARD, TEAM, FIRST_NAME, OTHER_NAME, CHANNEL_SOCIAL, SOCIAL_CHANNEL, ["bugs channel", "#your-real-channel"]],
    dialog: true,
    status: "ok",
    result: 'Updated "bugs channel": #your-real-channel → #social (v2).',
  },
  {
    id: "row 396",
    source: "action log",
    instruction: "forget the bugs channel",
    arguments: { subject: "bugs channel", value: "" },
    mode: "webhook",
    before: [
      TONE, DASHBOARD, TEAM, FIRST_NAME, OTHER_NAME, CHANNEL_SOCIAL, SOCIAL_CHANNEL,
      ["bugs channel", "#your-real-channel"], ["bugs channel", "#social"],
    ],
    dialog: false,
    status: "error",
    result: "I need both what to remember and what its value is.",
  },
  {
    id: "row 435",
    source: "action log",
    instruction: "remember my name is [full name] not [other name]",
    arguments: { subject: "name", value: "[full name]" },
    mode: "webhook",
    before: [TONE, DASHBOARD, TEAM, FIRST_NAME, OTHER_NAME, CHANNEL_SOCIAL, SOCIAL_CHANNEL, ["bugs channel", "help"]],
    dialog: true,
    status: "ok",
    result: 'Updated "name": [other name] → [full name] (v3).',
  },
  {
    // Refused by M22's check (now in `prepare`): Slack had no #fun then.
    id: "row 475",
    source: "action log",
    instruction: "remember the second channel is fun channel",
    arguments: { subject: "the second channel", value: "fun channel" },
    mode: "bot",
    before: OCT_12,
    dialog: false,
    status: "refused",
    result:
      "I couldn't find a Slack channel called #fun channel. I can post to public channels and to private channels the bot has been added to.",
  },
  {
    id: "row 591",
    source: "action log",
    instruction: "Samurai is this.",
    arguments: { subject: "Samurai", value: CLIPBOARD_MARKER },
    mode: "bot",
    before: OCT_22,
    dialog: false,
    status: "ok",
    result: `Remembered: samurai = ${CLIPBOARD_MARKER}`,
  },

  // --- M32's scripted run ---
  {
    id: "M32 correction",
    source: "M32 scripted run",
    instruction: "actually, post it in social instead",
    arguments: { subject: "team", value: "social" },
    mode: "bot",
    before: [...OCT_22, ["samurai", CLIPBOARD_MARKER]],
    dialog: true,
    status: "ok",
    result: 'Updated "team": #social → social (v2).',
  },

  // --- The scripted evals and flagship tests ---
  {
    id: "demoTasks #4",
    source: "scripted eval",
    instruction: "remember my upwork is https://upwork.com/me",
    arguments: { subject: "target:upwork", value: "https://upwork.com/me" },
    mode: "webhook",
    before: [["tone", "concise and warm"], ["team", "#design-team"], ["target:dashboard", "https://dash.example.com"]],
    dialog: false,
    status: "ok",
    result: "Remembered: target:upwork = https://upwork.com/me",
  },
  {
    id: "demoTasks #6",
    source: "scripted eval",
    instruction: "no, I meant #general",
    arguments: { subject: "team", value: "#general" },
    mode: "webhook",
    before: [["tone", "concise and warm"], ["team", "#design-team"], ["target:dashboard", "https://dash.example.com"]],
    dialog: true,
    status: "ok",
    result: 'Updated "team": #design-team → #general (v2).',
  },
  {
    id: "story step 2",
    source: "scripted eval",
    instruction: "my dashboard is https://old.example.com",
    arguments: { subject: "target:dashboard", value: "https://old.example.com" },
    mode: "webhook",
    before: [],
    dialog: false,
    status: "ok",
    result: "Remembered: target:dashboard = https://old.example.com",
  },
  {
    id: "story step 4",
    source: "scripted eval",
    instruction: "no, I meant the new one",
    arguments: { subject: "target:dashboard", value: "https://new.example.com" },
    mode: "webhook",
    before: [["target:dashboard", "https://old.example.com"]],
    dialog: true,
    status: "ok",
    result: 'Updated "target:dashboard": https://old.example.com → https://new.example.com (v2).',
  },
  {
    id: "remember.test new fact",
    source: "scripted eval",
    instruction: "remember my tone is concise and warm",
    arguments: { subject: "tone", value: "concise and warm" },
    mode: "webhook",
    before: [],
    dialog: false,
    status: "ok",
    result: "Remembered: tone = concise and warm",
  },
  {
    id: "remember.test subject guard",
    source: "scripted eval",
    instruction: "the team is the design channel",
    arguments: { subject: "the team", value: "#design-team" },
    mode: "webhook",
    before: [["team", "#general"]],
    dialog: true,
    status: "ok",
    result: 'Updated "team": #general → #design-team (v2).',
  },
  {
    id: "M4 flagship: the new dashboard",
    source: "scripted eval",
    instruction: "no, I meant the new dashboard",
    arguments: { subject: "target:dashboard", value: "https://new.example.com" },
    mode: "webhook",
    before: [["target:dashboard", "https://old.example.com"]],
    dialog: true,
    status: "ok",
    result: 'Updated "target:dashboard": https://old.example.com → https://new.example.com (v2).',
  },
  {
    id: "M4 flagship: the design channel",
    source: "scripted eval",
    instruction: "no, I meant the design channel",
    arguments: { subject: "team", value: "#design-team" },
    mode: "webhook",
    before: [["team", "#general"]],
    dialog: true,
    status: "ok",
    result: 'Updated "team": #general → #design-team (v2).',
  },
  {
    id: "M4 flagship: the tone",
    source: "scripted eval",
    instruction: "actually my tone is concise and warm",
    arguments: { subject: "tone", value: "concise and warm" },
    mode: "webhook",
    before: [["tone", "stiff and formal"]],
    dialog: true,
    status: "ok",
    result: 'Updated "tone": stiff and formal → concise and warm (v2).',
  },
];
