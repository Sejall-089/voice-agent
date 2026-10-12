import type { ActionLog, PlannerOutcome } from "../core/types.ts";

// THE planner call site, extracted so it is one named thing rather than a closure inside
// app.whenReady(). Typed text and dictated text both arrive here, which is what lets voice
// exist without /core knowing about it — and now it is also directly testable, since
// importing main.ts would boot electron.

export interface ThinkingShell {
  // Turns the bar's "Thinking…" indicator on and off.
  showThinking(on: boolean): void;
  // Where a run that broke before it could report anything says so (M22 prompt 11).
  showResult(text: string): void;
}

// Said when the planner itself threw — the model could not be reached, say — so nothing was
// decided and nothing reported. Fixed text: an error's own message is never shown or logged here,
// because an HTTP client may quote the request it failed to send.
export const RUN_FAILED =
  "I couldn't finish that: something went wrong before anything was done. Check your connection and try again.";

// The error's class, for the console: "APIConnectionError", "TypeError". Never its message.
function errorClass(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || error.name || "Error";
  return typeof error;
}

export interface PlannerLike {
  run(instruction: string): Promise<PlannerOutcome>;
}

export function createRunInstruction(
  planner: PlannerLike,
  shell: ThinkingShell,
  // Where a run that THREW is recorded (M23-pre). Optional: without it, a throw is shown and
  // printed but not logged, as before. main.ts passes the same SqliteMemory the planner logs to.
  log?: Pick<ActionLog, "logAction">,
): (instruction: string) => Promise<void> {
  return async (instruction: string): Promise<void> => {
    if (instruction.trim().length === 0) return;

    // A planner run is 6-13s, almost all of it waiting on the model, and the bar showed
    // nothing at all during it — a wait that looks identical to a hang. This does not make
    // anything faster; it makes the time legible.
    shell.showThinking(true);
    try {
      const outcome = await planner.run(instruction); // captures context, plans, shows the result
      // ONE LINE OF GROUND TRUTH, added at M16.11.
      //
      // Until now the only place an outcome appeared was the command bar, in the renderer — and
      // the bar's own accessibility tree exposes nothing but "Chrome Legacy Window", so there
      // was no way to see what the app had decided except by watching the screen. That is how
      // the M16.9 snapshot bug survived: it produced a perfectly reasonable refusal naming the
      // wrong window, and nothing recorded which window it had actually read.
      //
      // Deliberately the OUTCOME and not the instruction: what was typed may be personal, and
      // the action log already records that with the user's consent. This is what the app did.
      //
      // M17 adds how much of a CHAIN ran, because `refused` alone cannot tell a plan that died
      // on step 1 from one that died on step 3 — and live testing has to be able to tell those
      // apart. Absent entirely for a single-step run, which is what every line before this
      // milestone was.
      const chain = outcome.chain ? ` (chain ${outcome.chain.completed}/${outcome.chain.total})` : "";
      // M19. What the model was told, on the same ground-truth line as what it then did:
      // whether the email hint was in the prompt, how long the Gmail check took, and how many
      // characters of clipboard went with it. Numbers and a flag — never the clipboard itself.
      const told = outcome.planning
        ? ` [email hint: ${outcome.planning.emailHint ? "sent" : "not sent"}, ` +
          `check ${outcome.planning.emailCheckMs}ms; clipboard: ${outcome.planning.clipboardChars} chars]`
        : "";
      console.log(`[main] ${outcome.status}${chain}${told}: ${outcome.result ?? ""}`);
      // M19. When the model's answer was refused before anything ran, print what it actually
      // sent. The message on screen quotes one tool name; diagnosing the "functions." prefix
      // took the action log and a guess, because the plan itself had been thrown away. Console
      // only, and in full — the action log gets the tool names and nothing else.
      if (outcome.proposed?.plan !== undefined) {
        console.log(`[main] refused plan, as sent: ${JSON.stringify(outcome.proposed.plan)}`);
      }
      if (outcome.proposed?.tool !== undefined) {
        console.log(`[main] refused tool name, as sent: ${JSON.stringify(outcome.proposed.tool)}`);
      }
    } catch (error) {
      // A run that THREW never reached its own reporting — found live (M22): an offline model call
      // in `decide` left only an UnhandledPromiseRejectionWarning in the console and nothing in
      // the bar. The hotkey runs this fire-and-forget, so a rejection here is lost. Say so, in
      // fixed words, and name only the error's class on the console.
      console.error(`[main] error: ${errorClass(error)}`);
      shell.showResult(RUN_FAILED);
      // And a row in the action log (M23-pre), shaped like `refuseIncomplete`'s: no tool, no
      // arguments, the instruction as every row records it, and the FIXED text as the result —
      // never the error's message. `error`, not `refused`: something broke; nothing was declined.
      // Guarded on its own: a log that cannot be written must not undo the report above.
      if (log !== undefined) {
        try {
          log.logAction({
            ts: new Date().toISOString(),
            instruction,
            tool: null,
            arguments: null,
            result: RUN_FAILED,
            status: "error",
          });
        } catch {
          console.error("[main] error: the action log could not record it");
        }
      }
    } finally {
      // finally, not after: a thrown planner must not leave the bar claiming to think
      // forever. There is no path out of here that keeps the indicator up.
      shell.showThinking(false);
    }
  };
}
