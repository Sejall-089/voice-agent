// The clipboards M28's plan-choice eval ran with (tests/eval/planChoice.eval.test.ts), shared so
// M30's replay of that eval's table (tests/unaskedSteps.test.ts) is judged against the same text.
// Moved here unchanged.

// Sixty words about an offsite: nothing like a bug. A stand-in; what was on the clipboard on the
// day of M19's second live retest was not recorded.
export const UNRELATED_TEXT =
  "Quarterly planning notes: the offsite moved to the 14th, catering is confirmed for " +
  "forty people, and the venue still needs a deposit by Friday. Parking is limited, so " +
  "encourage carpooling. Agenda draft is in the shared folder under Offsite/2026.";

// Prose and a stack trace, pasted out of a terminal (~1,500 characters). The long clipboard that
// reproduces M27's unrequested summarize step.
export const LONG_TRACE =
  "Tried the migration again on staging this morning and it still falls over about two thirds " +
  "of the way through. It gets past the users table fine, then dies on orders. I restarted the " +
  "worker twice and cleared the queue, same result both times.\n\n" +
  "I think it's the batch size — the job loads every row for a customer into memory before it " +
  "writes anything, and a couple of the bigger accounts have six-figure order counts. Dropping " +
  "the batch to 500 got further but then hit a timeout instead.\n\n" +
  "Error: Connection terminated unexpectedly\n" +
  "    at Connection.<anonymous> (/srv/app/node_modules/pg/lib/client.js:132:73)\n" +
  "    at Object.onceWrapper (node:events:632:28)\n" +
  "    at Connection.emit (node:events:518:28)\n" +
  "    at Socket.<anonymous> (/srv/app/node_modules/pg/lib/connection.js:63:12)\n" +
  "    at migrateOrders (/srv/app/dist/jobs/migrate.js:214:19)\n" +
  "    at async runBatch (/srv/app/dist/jobs/migrate.js:88:5)\n" +
  "    at async Worker.process (/srv/app/dist/worker.js:41:9)\n\n" +
  "Going to leave it for now and pick it up after lunch. If anyone has seen pg drop the " +
  "connection mid-transaction like this before, shout — I'd rather not bisect the whole job.";

// A one-line bug (~110 characters). Never showed the unrequested step (0 of 6).
export const SHORT_BUG =
  "Login button does nothing on mobile Safari after the 2.3 update: tapping it shows no " +
  "spinner and no error.";
