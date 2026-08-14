import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export function CommandBar(): JSX.Element {
  const [text, setText] = useState("");
  const [echo, setEcho] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focusInput = (): void => {
      // Defer so focus lands after the window is actually shown/visible.
      requestAnimationFrame(() => inputRef.current?.focus());
    };

    const offShow = window.api.onShow(() => {
      setText("");
      setEcho(null);
      focusInput();
    });
    const offEcho = window.api.onEcho((value) => setEcho(value));
    const offReset = window.api.onReset(() => {
      setText("");
      setEcho(null);
    });

    return () => {
      offShow();
      offEcho();
      offReset();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      const value = text.trim();
      if (value.length > 0) {
        window.api.submit(value);
      }
    } else if (e.key === "Escape") {
      window.api.close();
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
      {echo !== null && <div className="command-echo">You typed: {echo}</div>}
    </div>
  );
}
