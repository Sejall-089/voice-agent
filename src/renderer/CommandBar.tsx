import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { MicRecorder } from "./audio/recorder.ts";

type VoiceState = "idle" | "recording" | "transcribing";

export function CommandBar(): JSX.Element {
  const [text, setText] = useState("");
  const [echo, setEcho] = useState<string | null>(null);
  const [voice, setVoice] = useState<VoiceState>("idle");
  const [heard, setHeard] = useState<string | null>(null);
  // Which combo the OS actually granted — the requested one may have been taken.
  const [voiceHotkey, setVoiceHotkey] = useState("Ctrl+Alt+Space");
  const inputRef = useRef<HTMLInputElement>(null);
  // One recorder for the window's lifetime — the mic is opened and released per recording.
  const recorderRef = useRef<MicRecorder>(new MicRecorder());
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
      focusInput();
    });
    const offEcho = window.api.onEcho((value) => setEcho(value));
    const offReset = window.api.onReset(() => {
      setText("");
      setEcho(null);
      setHeard(null);
    });

    // --- Voice (M7). Main owns the state machine; the renderer just runs the microphone. ---

    const offVoiceStart = window.api.onVoiceStart(() => {
      setEcho(null);
      setHeard(null);
      void recorderRef.current
        .start()
        .then(() => window.api.voiceStarted())
        .catch((error: unknown) => window.api.voiceStarted(describe(error)));
    });

    const offVoiceStop = window.api.onVoiceStop(() => {
      void recorderRef.current
        .stop()
        .then((clip) => window.api.sendAudio(clip))
        .catch((error: unknown) => window.api.sendAudio(null, describe(error)));
    });

    const offVoiceCancel = window.api.onVoiceCancel(() => {
      void recorderRef.current.cancel();
    });

    const offVoiceHotkey = window.api.onVoiceHotkey((combo) => {
      // Electron's "CommandOrControl" is just "Ctrl" on Windows.
      if (combo) setVoiceHotkey(combo.replace("CommandOrControl", "Ctrl"));
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
      offVoiceStart();
      offVoiceStop();
      offVoiceCancel();
      offVoiceHotkey();
      offVoiceState();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      const value = text.trim();
      if (value.length > 0) {
        window.api.submit(value);
      }
    } else if (e.key === "Escape") {
      // While recording, Escape discards the take rather than closing the bar.
      if (voiceRef.current === "recording") {
        window.api.cancelVoice();
      } else {
        window.api.close();
      }
    }
  };

  return (
    <div className="command-bar">
      <input
        ref={inputRef}
        className="command-input"
        type="text"
        placeholder="Type a command…  (Enter to run · Esc to close)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        autoFocus
      />

      {/* The "you left it running" cue. Without it a toggle mode is easy to forget. */}
      {voice === "recording" && (
        <div className="voice-indicator recording">
          <span className="voice-dot" />
          Recording…{" "}
          <span className="voice-hint">{voiceHotkey} to stop · Esc to discard</span>
        </div>
      )}
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
