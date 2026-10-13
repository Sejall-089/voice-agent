import type { Database } from "better-sqlite3";

// App settings (M23): small things the user switched, that should still be switched after a
// restart. One today — whether the needs-you chime is muted.
//
// Its own table and its own interface, deliberately not a fact in the memory engine: a fact is
// something the user taught the app, it is versioned, `recall` reads it back and a vague
// reference can resolve to it. "The chime is muted" is none of those.
export interface SettingsStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const CHIME_MUTED = "chime.muted";

// A boolean setting. Anything that is not exactly "1" is false, so a missing row, a blank
// value and a value some other version wrote all mean the default.
export function readFlag(settings: SettingsStore, key: string): boolean {
  return settings.get(key) === "1";
}

export function writeFlag(settings: SettingsStore, key: string, on: boolean): void {
  settings.set(key, on ? "1" : "0");
}

export class InMemorySettings implements SettingsStore {
  private readonly values = new Map<string, string>();

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }
}

// The `settings` table (core/memory/db.ts), in the same injected database as everything else.
export class SqliteSettings implements SettingsStore {
  constructor(private readonly db: Database) {}

  get(key: string): string | null {
    const row = this.db
      .prepare<[string], { value: string }>(`SELECT value FROM settings WHERE key = ?`)
      .get(key);
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }
}
