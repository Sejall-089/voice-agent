# GitHub MCP fixtures (M20)

Captured from GitHub's hosted MCP server (`https://api.githubcopilot.com/mcp/`) with
`scripts/github-recon.mjs`, which is read-only by rule. Nothing here came from documentation
or from memory, except the two items marked "from source" below.

## tools.json

The server's own `tools/list` entries for the three remote tools the connector pins
(`issue_write`, `issue_read`, `list_issues`), plus `delete_file` as the specimen of a tool the
server marks destructive. Rewritten by `npm run github:recon -- --tools-fixture`.

**Edited in one way:** each tool's `icons` array is removed. The icons are two base64 PNGs per
tool, about nine tenths of the listing (the full 46-tool listing is 156 KB with them), and
nothing reads them. Everything else — names, descriptions, input schemas, annotations, `_meta`
— is exactly what the server sent. The other 42 tools are left out; the connector cannot name
them.

## captured.ts

Result and error texts, sanitised (owner, repository, logins, ids and issue text replaced;
structure and error wording untouched).

| What | How it was obtained |
|---|---|
| Empty list | Verbatim from the recon repository, before it had any issues. |
| Non-empty list (all, and `OPEN` only), single issue (open, and closed) | **Captured 2026-10-10** from the recon repository's two hand-made issues: #1 open, #2 closed. Titles, bodies and timestamps are theirs; owner, repository, login, id and cursors are replaced. |
| List with more issues than the page (`LIST_RESULT_MORE`) | Structure from a read-only call against a public repository (`github/github-mcp-server`); the content is replaced. The recon repository has only two issues. |
| 404, missing repository, missing argument, bad enum | Verbatim from the recon repository. |
| "Resource not accessible by personal access token" | Verbatim, from `list_branches`, which the recon token may not call. A stand-in: the same failure on an *issue* call has not been captured. |
| Rate limit | Verbatim from `search_issues`, with the user ID and request ID replaced. |
| Rejected token | Verbatim (type, code and message). |
| **Create result** | **From source**, not captured: `MinimalResponse` in the server's `pkg/github/minimal_types.go`. No script may create a real issue. |
| **Form handoff** | **From source**, never seen live: `issueWriteAwaitingFormResult` in `pkg/github/issues.go`. |

What a *create* failure looks like (a token without write access, a repository with issues
switched off, a rejected title) has not been measured: measuring it means a write call.
