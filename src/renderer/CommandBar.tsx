import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { MicRecorder } from "./audio/recorder.ts";

type VoiceState = "idle" | "recording" | "stopped" | "transcribing";

export function CommandBar(): JSX.Element {
  const [text, setText] = useState("");
  const [echo, setEcho] = useState<string | null>(null);
  const [voice, setVoice] = useState<VoiceState>("idle");
  const [heard, setHeard] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  // Narration for a `caution` action (M10): "Reading the open email and drafting a reply…".
  // Separate from `echo` because it is what is ABOUT to happen, not the result.
  const [status, setStatus] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // One recorder for the window's lifetime — the mic is opened and released per recording.
  // useRef(null) + lazy init, not useRef(new MicRecorder()): the latter constructs a
  // throwaway recorder on every single render.
  const recorderRef = useRef<MicRecorder | null>(null);
  const recorder = (recorderRef.current ??= new MicRecorder());
  // One "I started typing" signal per bar opening, not one per keystroke.
  const typedRef = useRef(false);
  // Read inside IPC callbacks, which close over the first render's state otherwise.
  const voiceRef = useRef<VoiceState>("idle");
  voiceRef.current = voice;

  useEffect(() => {
    const focusInput = (): void => {
      // Defer so focus lands after the window is actually shown/visible.
      requestAnimationFrame(() => inputRef.current?.focus());
    };

    const offShow = window.api.onShow(() => {
      setText("");
      setEcho(null);
      setHeard(null);
      setThinking(false);
      setStatus(null);
      typedRef.current = false;
      focusInput();
    });
    // The result supersedes the narration: once the action has happened, saying what it was
    // about to do is just stale.
    const offEcho = window.api.onEcho((value) => {
      setStatus(null);
      setEcho(value);
    });
    const offStatus = window.api.onStatus((value) => setStatus(value));
    const offReset = window.api.onReset(() => {
      setText("");
      setEcho(null);
      setHeard(null);
      setThinking(false);
      setStatus(null);
    });

    const offThinking = window.api.onThinking((on) => setThinking(on));

    // --- Voice (M7). Main owns the state machine; the renderer just runs the microphone. ---

    const offVoiceStart = window.api.onVoiceStart(() => {
      setEcho(null);
      setHeard(null);
      void recorder
        .start()
        .then(() => window.api.voiceStarted())
        .catch((error: unknown) => window.api.voiceStarted(describe(error)));
    });

    const offVoiceStop = window.api.onVoiceStop(() => {
      void recorder
        .stop()
        .then((clip) => window.api.sendAudio(clip))
        .catch((error: unknown) => window.api.sendAudio(null, describe(error)));
    });

    const offVoiceCancel = window.api.onVoiceCancel(() => {
      void recorder.cancel();
    });

    const offVoiceState = window.api.onVoiceState((state, detail) => {
      setVoice(state as VoiceState);
      if (state === "idle" && detail) setHeard(detail);
      if (state === "recording") setHeard(null);
    });

    return () => {
      offShow();
      offEcho();
      offReset();
      offThinking();
      offStatus();
      offVoiceStart();
      offVoiceStop();
      offVoiceCancel();
      offVoiceState();
    };
  }, []);

  // Typing is how you say "not this time" to the microphone. Sent once per opening, on
  // the first real text change, so it never fires for arrow keys or a stray Shift.
  const onChange = (value: string): void => {
    setText(value);
    if (!typedRef.current && value.length > 0) {
      typedRef.current = true;
      window.api.notifyTyping();
    }
  };

  const listening = voiceRef.current === "recording" || voiceRef.current === "stopped";

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      const value = text.trim();
      // An empty bar submits ONLY while dictating — there Enter means "stop talking, run
      // it". With nothing typed and nothing recorded there is nothing to run.
      if (value.length > 0 || listening) {
        window.api.submit(value);
      }
    } else if (e.key === "Escape") {
      // A FALLBACK, not the primary path: main.ts registers Escape as a global shortcut
      // while the bar is visible, so it works even when the bar never had OS focus (the
      // normal case while dictating). This only fires if that registration somehow failed
      // and the bar happens to have focus anyway.
      window.api.close();
    }
  };

  return (
    <div className="command-bar">
      <input
        ref={inputRef}
        className="command-input"
        type="text"
        placeholder="Speak, or type…  (Enter to run · Esc to cancel)"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        autoFocus
      />

      {/* The "it is listening right now" cue, and what to do about it. */}
      {voice === "recording" && (
        <div className="voice-indicator recording">
          <span className="voice-dot" />
          Listening…{" "}
          <span className="voice-hint">Enter to run · type to cancel · Esc to close</span>
        </div>
      )}
      {voice === "stopped" && (
        <div className="voice-indicator stopped">
          <span className="voice-dot" />
          Stopped at 90s.{" "}
          <span className="voice-hint">Enter to run what you said · Esc to discard</span>
        </div>
      )}
      {/* The planner is working. 6-13s of it is the model, and an empty bar during that
          is indistinguishable from a hang. Shown for typed and dictated runs alike. */}
      {thinking && (
        <div className="voice-indicator thinking">
          <span className="voice-dot" />
          Thinking…
        </div>
      )}
      {/* What the app is about to do inside another app, said before it does it. There is no
          undo for opening someone's reply box, so being told is the protection. */}
      {status !== null && <div className="command-status">{status}</div>}
      {voice === "transcribing" && (
        <div className="voice-indicator transcribing">
          <span className="voice-dot" />
          Transcribing…
        </div>
      )}

      {heard !== null && <div className="voice-heard">Heard: “{heard}”</div>}
      {echo !== null && <div className="command-echo">{echo}</div>}
    </div>
  );
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // The single most likely failure on Windows 11, and the message alone doesn't say it.
    if (error.name === "NotAllowedError") {
      return "microphone access was denied (Settings → Privacy → Microphone).";
    }
    if (error.name === "NotFoundError") return "no microphone was found.";
    return error.message;
  }
  return String(error);
}
