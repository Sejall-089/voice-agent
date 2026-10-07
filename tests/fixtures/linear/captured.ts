// What Linear's MCP server ACTUALLY returns, transcribed from scripts/linear-recon.mjs on
// 2026-10-07 (server "Linear MCP" 1.0.0). Nothing in this file was written from documentation
// or from memory — CLAUDE.md's "recon before fixtures" rule, and the reason it exists.
//
// Every payload is the `text` of the ONE text content block a result carried. That is the whole
// finding about shape: no structuredContent, no resource_link, no outputSchema on any tool. An
// issue's URL is the `url` field of JSON-inside-a-string, and a failure is a normal result with
// `isError: true` — never a thrown error.
//
// SANITISED, structure untouched: the workspace slug, team name, user name and UUIDs are
// replaced with neutral ones, and long descriptions are shortened. Field names, field order,
// nesting, nulls and the two different error formats are exactly as captured.
//
// tools.json beside this file is the unedited `tools/list` entry for the three tools the
// connector uses, plus `delete_comment` as the specimen of a tool the server marks destructive.

// `list_issues` with the arguments the connector fixes in code: limit 5, fields id/title/status/url.
export const SEARCH_RESULT =
  '{"issues":[{"id":"ENG-3","title":"Import your data","status":"Todo","url":"https://linear.app/acme/issue/ENG-3/import-your-data"},' +
  '{"id":"ENG-4","title":"Set up your teams","status":"Todo","url":"https://linear.app/acme/issue/ENG-4/set-up-your-teams"}],' +
  '"hasNextPage":false}';

export const SEARCH_RESULT_EMPTY = '{"issues":[],"hasNextPage":false}';

// `get_issue` with only `id`.
export const GET_RESULT =
  '{"id":"ENG-4","uuid":"00000000-0000-4000-8000-000000000004","title":"Set up your teams",' +
  '"description":"Teams are how you organize people and work in Linear.\\n\\n* [Learn about Teams](<https://linear.app/docs/teams>)\\n  How to structure teams and configure workflows",' +
  '"priority":{"value":0,"name":"No priority"},"url":"https://linear.app/acme/issue/ENG-4/set-up-your-teams",' +
  '"gitBranchName":"sam/eng-4-set-up-your-teams","createdAt":"2026-10-07T17:38:04.460Z","updatedAt":"2026-10-07T17:38:04.460Z",' +
  '"archivedAt":null,"completedAt":null,"startedAt":null,"canceledAt":null,"dueDate":null,"slaStartedAt":null,' +
  '"slaMediumRiskAt":null,"slaHighRiskAt":null,"slaBreachesAt":null,"status":"Todo","statusType":"unstarted","labels":[],' +
  '"attachments":[],"documents":[],"stateHistory":[{"state":{"id":"00000000-0000-4000-8000-0000000000aa","name":"Todo","type":"unstarted"},' +
  '"startedAt":"2026-10-07T17:38:04.460Z","endedAt":null}],"team":"Engineering","teamId":"00000000-0000-4000-8000-0000000000bb"}';

// `save_issue` with title + description + team and NO id — a create. Captured once, by hand,
// during recon; nothing automated ever creates a real issue.
export const CREATE_RESULT =
  '{"id":"ENG-5","uuid":"00000000-0000-4000-8000-000000000005","title":"Login button does nothing on Safari",' +
  '"description":"From: Dana <dana@example.com>\\nSubject: Login broken\\n\\nClicking Log in does nothing on Safari 17.",' +
  '"priority":{"value":0,"name":"No priority"},"url":"https://linear.app/acme/issue/ENG-5/login-button-does-nothing-on-safari",' +
  '"gitBranchName":"sam/eng-5-login-button-does-nothing-on-safari","createdAt":"2026-10-07T17:42:41.235Z","updatedAt":"2026-10-07T17:42:41.235Z",' +
  '"archivedAt":null,"completedAt":null,"startedAt":null,"canceledAt":null,"dueDate":null,"slaStartedAt":null,' +
  '"slaMediumRiskAt":null,"slaHighRiskAt":null,"slaBreachesAt":null,"status":"Backlog","statusType":"backlog","labels":[],' +
  '"attachments":[],"documents":[],"createdBy":"Sam Example","createdById":"00000000-0000-4000-8000-0000000000cc",' +
  '"team":"Engineering","teamId":"00000000-0000-4000-8000-0000000000bb"}';

// --- Failures. All four arrived as `isError: true` results. TWO DIFFERENT FORMATS: a lookup
// that fails upstream is JSON with a `message`; everything else is a bare sentence. ---

export const ERROR_ISSUE_NOT_FOUND =
  '{"error":"invalid_request","message":"Could not find referenced Issue.","status":400,"requestId":"a46eb38a6b890ac9"}';

export const ERROR_TEAM_REQUIRED = "Error: team is required when creating an issue";

export const ERROR_TEAM_UNKNOWN = 'Error: Could not find team "No Such Team ZZZ"';

export const ERROR_UNKNOWN_KEY =
  'Input validation error: Invalid arguments for tool save_issue: Unrecognized key: "bogus"';

export const ERROR_MISSING_ID =
  "Input validation error: Invalid arguments for tool get_issue: id: Invalid input: expected string, received undefined";

// What a rejected key looks like — NOT a result at all. `client.connect()` rejects with the
// SDK's StreamableHTTPError, `code` 401, and this message.
export const BAD_KEY_STATUS = 401;
export const BAD_KEY_MESSAGE =
  'Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token","error_description":"Invalid access token"}';
