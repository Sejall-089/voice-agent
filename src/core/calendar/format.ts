import type { CalendarEvent } from "../types.ts";

// Turning events into the words a human reads — in narration, in the confirm dialog, and in
// readSchedule's result. Pure, so the exact wording of a confirm prompt is testable: that text
// is the last thing standing between an instruction and an invite in someone's inbox, and
// "what did it actually say?" has to be answerable without a calendar.
//
// Everything here renders in the CALENDAR's timezone, not the machine's, so times read the way
// they do in Google Calendar. The user's own local zone is a different thing used for a
// different job (interpreting "3pm" when they say it — spec §5).

// "Tue 26 Aug, 3:00–4:00 PM" · "Tue 26 Aug, 11:30 PM – Wed 27 Aug, 12:30 AM" · "Wed 26 Aug (all day)"
export function formatWhen(event: CalendarEvent, timeZone: string): string {
  if (event.allDay) {
    const first = formatDay(event.start, timeZone);
    // The end is already the inclusive last day (googleCalendarMap normalizes Google's
    // exclusive one away), so a single-day event has start === end.
    return event.start === event.end
      ? `${first} (all day)`
      : `${first} – ${formatDay(event.end, timeZone)} (all day)`;
  }

  const startDay = formatDay(event.start, timeZone);
  const endDay = formatDay(event.end, timeZone);
  const startTime = formatTime(event.start, timeZone);
  const endTime = formatTime(event.end, timeZone);

  // A meeting that crosses midnight has to name the second day, or "11:30 PM – 12:30 AM" reads
  // as an hour that already happened.
  if (startDay !== endDay) {
    return `${startDay}, ${startTime} – ${endDay}, ${endTime}`;
  }
  return `${startDay}, ${withinDay(startTime, endTime)}`;
}

// "3:00–4:00 PM", but "11:00 AM–1:00 PM".
//
// The meridiem is written once when both ends share it, because that is how people write a
// time range — and twice when they do not, because dropping it there would turn a two-hour
// lunchtime meeting into one that reads as ending before it started.
function withinDay(startTime: string, endTime: string): string {
  const startMeridiem = startTime.slice(-2);
  if (startMeridiem === endTime.slice(-2)) {
    return `${startTime.slice(0, -3)}–${endTime}`;
  }
  return `${startTime}–${endTime}`;
}

// "Design review" on Tue 26 Aug, 3:00–4:00 PM
export function describeEvent(event: CalendarEvent, timeZone: string): string {
  return `"${event.title}" on ${formatWhen(event, timeZone)}`;
}

// "alex@example.com and sam@example.com" — every address, never "and 3 others".
//
// The confirm dialog is the last moment anyone can stop an invite going out, so it names each
// person in full. Same reasoning that makes sendReply show the whole draft rather than a
// preview: a truncated list is exactly where the wrong recipient hides.
export function formatAttendees(attendees: readonly string[]): string {
  if (attendees.length === 0) return "";
  if (attendees.length === 1) return attendees[0] ?? "";
  const rest = attendees.slice(0, -1).join(", ");
  return `${rest} and ${attendees[attendees.length - 1] ?? ""}`;
}

// The schedule as a readable list. `readSchedule` is `safe` and its whole output is this text.
export function formatSchedule(events: readonly CalendarEvent[], timeZone: string): string {
  return events
    .map((event) => {
      const guests =
        event.attendees.length > 0 ? ` — with ${formatAttendees(event.attendees)}` : "";
      return `• ${formatWhen(event, timeZone)} — ${event.title}${guests}`;
    })
    .join("\n");
}

// "Tue 26 Aug"
function formatDay(value: string, timeZone: string): string {
  // An all-day value (YYYY-MM-DD) has no time and no zone. Reading it back at UTC midnight and
  // formatting it in UTC keeps it on its own date; running it through the calendar's zone would
  // push it a day in either direction depending on the offset's sign.
  const allDay = !value.includes("T");
  const at = allDay ? Date.parse(`${value}T00:00:00Z`) : Date.parse(value);
  const written = new Intl.DateTimeFormat("en-GB", {
    timeZone: allDay ? "UTC" : timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(at));

  // Drop the comma some ICU builds put after the weekday, so this string has ONE shape
  // everywhere. Not cosmetic: node renders "Wed 26 Aug" and electron renders "Wed, 26 Aug" for
  // the same instant, and everything downstream — the schedule line's own " — " joins, the
  // speech transform's date expansion — is written against a shape. Letting that shape vary by
  // runtime means the tests describe node while the user hears electron, which is exactly how
  // "Wed" and "Aug" ended up being read aloud as words in M14's live pass.
  return written.replace(/^(\w{3,4}),/, "$1");
}

// "3:00 PM"
function formatTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(Date.parse(value)));
}
