// What GitHub's hosted MCP server ACTUALLY returns, transcribed from scripts/github-recon.mjs
// and the M20 phase-2 probes on 2026-10-09/10 (server "github-mcp-server", build
// remote-7eab724, protocol 2025-11-25). README.md beside this file says how each piece was
// obtained — and, for the two that were NOT captured, says so.
//
// The finding about shape is the same as Linear's: every result is ONE text content block
// holding a JSON string, with no structuredContent and no resource_link, and a failure is a
// normal result with `isError: true`. Where it differs from Linear is everything else:
//
//   - a failure's text is a bare sentence carrying the API URL that failed (so the owner and
//     repository), and for a rate limit a numeric user ID and a request ID;
//   - a list item has NO url, and its `state` is upper-case where a single issue's is lower;
//   - an argument the server does not know is silently ignored, never refused.
//
// SANITISED, structure untouched: the owner, repository, logins, numeric ids, cursors and
// request ids are replaced with neutral ones. The two hand-made fixture issues keep their own
// titles, bodies and timestamps. Field names, field order, nesting and the wording of every
// error are exactly as captured.

export const OWNER = "acme";
export const REPO = "tracker";

// `list_issues` with the arguments the connector fixes in code: perPage 5,
// fields number/title/state, newest first. CAPTURED 2026-10-10 from the recon repository's two
// hand-made issues. Note the field ORDER inside an item is the server's (number, state, title),
// not the order `fields` asked for; and that the newer issue, #2, comes first.
export const LIST_RESULT =
  '{"issues":[{"number":2,"state":"CLOSED","title":"Fixture issue to close"},' +
  '{"number":1,"state":"OPEN","title":"Fixture issue with body"}],' +
  '"pageInfo":{"hasNextPage":false,"hasPreviousPage":false,"startCursor":"Y3Vyc29yOnYyOpK0AAAAAAAAAAAAAAAAAAAAAAI=","endCursor":"Y3Vyc29yOnYyOpK0AAAAAAAAAAAAAAAAAAAAAAE="},' +
  '"totalCount":2}';

// The same call with `state: "OPEN"`. `totalCount` counts what MATCHED, not the repository.
export const LIST_RESULT_OPEN =
  '{"issues":[{"number":1,"state":"OPEN","title":"Fixture issue with body"}],' +
  '"pageInfo":{"hasNextPage":false,"hasPreviousPage":false,"startCursor":"Y3Vyc29yOnYyOpK0AAAAAAAAAAAAAAAAAAAAAAE=","endCursor":"Y3Vyc29yOnYyOpK0AAAAAAAAAAAAAAAAAAAAAAE="},' +
  '"totalCount":1}';

// More issues than the page holds. NOT from the recon repository (it has two issues): the
// structure is from a read-only call against a public one, with the content replaced.
export const LIST_RESULT_MORE =
  '{"issues":[{"number":179,"state":"OPEN","title":"Newest"}],' +
  '"pageInfo":{"hasNextPage":true,"hasPreviousPage":false,"startCursor":"Y3Vyc29yOnYyOpK0AAAAAAAAAAAAAAAAAAAAALM=","endCursor":"Y3Vyc29yOnYyOpK0AAAAAAAAAAAAAAAAAAAAALM="},' +
  '"totalCount":179}';

// Verbatim, from the (empty) repository the recon ran against.
export const LIST_RESULT_EMPTY =
  '{"issues":[],"pageInfo":{"hasNextPage":false,"hasPreviousPage":false},"totalCount":0}';

// `issue_read` with method "get", for the OPEN issue. CAPTURED 2026-10-10. There is no
// `comments` key on an issue with none (a public issue with one comment carried `"comments":1`).
export const GET_RESULT =
  '{"number":1,"title":"Fixture issue with body","body":"Body part is not previewing properly. It is going out of the box, also font style also need attention.",' +
  '"state":"open","html_url":"https://github.com/acme/tracker/issues/1",' +
  '"user":{"login":"sam-example","id":100000001,"profile_url":"https://github.com/sam-example","avatar_url":"https://avatars.githubusercontent.com/u/100000001?v=4"},' +
  '"author_association":"OWNER","assignees":[],' +
  '"reactions":{"total_count":0,"+1":0,"-1":0,"laugh":0,"confused":0,"heart":0,"hooray":0,"rocket":0,"eyes":0},' +
  '"created_at":"2026-10-10T12:38:54Z","updated_at":"2026-10-10T12:38:54Z","has_parent":false,"has_children":false,' +
  '"closed_by_pull_requests":{"total_count":0,"references":[]}}';

// The same call for the CLOSED issue. CAPTURED 2026-10-10. A closed issue has three keys an
// open one does not — `state_reason`, `closed_at`, `closed_by` — and they sit in the MIDDLE of
// the object, so nothing may read these results by position.
export const GET_RESULT_CLOSED =
  '{"number":2,"title":"Fixture issue to close","body":"Check the issue details and review and resolve it.",' +
  '"state":"closed","state_reason":"completed","html_url":"https://github.com/acme/tracker/issues/2",' +
  '"user":{"login":"sam-example","id":100000001,"profile_url":"https://github.com/sam-example","avatar_url":"https://avatars.githubusercontent.com/u/100000001?v=4"},' +
  '"author_association":"OWNER","assignees":[],' +
  '"reactions":{"total_count":0,"+1":0,"-1":0,"laugh":0,"confused":0,"heart":0,"hooray":0,"rocket":0,"eyes":0},' +
  '"created_at":"2026-10-10T12:39:32Z","updated_at":"2026-10-10T12:40:03Z","closed_at":"2026-10-10T12:40:03Z","closed_by":"sam-example",' +
  '"has_parent":false,"has_children":false,"closed_by_pull_requests":{"total_count":0,"references":[]}}';

// `issue_write` with method "create". NOT CAPTURED — nothing automated may create a real issue.
// One was created by hand through the app on 2026-10-10 and the app read its result as this
// shape ("Created #3: …" with a working link), but the raw result was not saved. Transcribed
// from the server's source (pkg/github/minimal_types.go, `MinimalResponse`, and `createIssue` in issues.go):
// the database id as a string and the issue's html url, and nothing else. No title, no number.
export const CREATE_RESULT = '{"id":"4000000007","url":"https://github.com/acme/tracker/issues/8"}';

// --- Failures. Every one arrived as an `isError: true` result with one text block. ---

// `issue_read` for a number that does not exist. A repository that does not exist produces
// the SAME text apart from the path — the two cannot be told apart from this.
export const errorIssueNotFound = (owner: string, repo: string, number: number): string =>
  `failed to get issue: GET https://api.github.com/repos/${owner}/${repo}/issues/${number}: 404 Not Found []`;

// `list_issues` on a repository that does not exist (or that the token cannot see).
export const errorRepoNotFound = (owner: string, repo: string): string =>
  `failed to list issues: Could not resolve to a Repository with the name '${owner}/${repo}'.`;

export const ERROR_MISSING_NUMBER =
  "invalid arguments: normalize tool arguments: missing required parameter: issue_number";

export const ERROR_BAD_METHOD =
  'validating "arguments": validating root: validating /properties/method: enum: nope does not equal any of: [get get_comments get_sub_issues get_parent get_labels]';

// A token without the permission a call needs. Captured from `list_branches`, which this
// token may not call — the nearest READ-ONLY stand-in for "the token lacks Issues access".
// The sentence before the URL names the operation and differs per tool; the part the
// connector matches on is the status and reason after it.
export const errorNoPermission = (owner: string, repo: string): string =>
  `failed to list branches: GET https://api.github.com/repos/${owner}/${repo}/branches?page=1&per_page=30: 403 Resource not accessible by personal access token []`;

// A rate limit. Captured from `search_issues` (ten calls in a minute trips it). The user ID and
// request ID are placeholders of the captured shape; the rest is verbatim.
export const ERROR_RATE_LIMIT =
  "failed to search issues: GET https://api.github.com/search/issues?page=1&per_page=5&q=is%3Aissue+authentication&search_type=semantic: " +
  "403 API rate limit exceeded for user ID 100000001. If you reach out to GitHub Support for help, please include the request ID " +
  "F8E8:1E61D3:531DAA:592BD6:6AC90000 and timestamp 2026-10-09 18:59:07 UTC. For more on scraping GitHub and how it may affect your rights, " +
  "please review our Terms of Service (https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) [rate reset in 10s]";

// The "form handoff": `issue_write` answering that it showed a form INSTEAD of writing. NOT
// CAPTURED, and never seen live — transcribed from the server's source (issues.go,
// `issueWriteAwaitingFormResult`; utils/result.go, `NewToolResultAwaitingFormSubmission`). By
// that source it is sent only to a client that advertises the "io.modelcontextprotocol/ui"
// extension, which this app does not. It is here because the claim "it cannot fire for us"
// has not been tested by a real create, and its text reads like an instruction.
export const formHandoffText = (owner: string, repo: string): string =>
  `An interactive form has been shown to the user for creating a new issue in ${owner}/${repo}. ` +
  "STOP — do not call any other tools, do not respond as if the issue was created, " +
  "and do not claim the operation succeeded. The issue has NOT been created yet; " +
  "only the form was rendered. Wait silently for the user to review and click Submit. " +
  "When they do, the real result will be delivered to your context automatically.";

export const FORM_HANDOFF_STRUCTURED = {
  status: "awaiting_user_submission",
  reason: "An interactive form is being shown to the user. The operation has not been performed.",
};

// What a rejected token looks like — NOT a result at all. `client.connect()` rejects with the
// SDK's StreamableHTTPError, `code` 401, and this message (the trailing newline is the server's).
export const BAD_KEY_STATUS = 401;
export const BAD_KEY_MESSAGE =
  "Streamable HTTP error: Error POSTing to endpoint: unauthorized: token authentication failed\n";
