## 1. Problem 实体与持久化

- [x] 1.1 Add `tools/problems.mjs`: `createProblem`/`updateProblem`/`listProblems`/`getProblem` with id generation, triage enum (bug/design/discuss/defer/wontfix), status enum (open/in_progress/fixed/closed), decisions audit trail (defer/wontfix require reason), discussion array, github ref, change_ref; atomic write (tmp + rename)
- [x] 1.2 Add `tools/problems.test.mjs`: entity creation from report, triage/status transitions incl. reject without reason, reopen from defer/wontfix, decisions trail, persistence round-trip, corrupt file handling

## 2. 服务端 API

- [x] 2.1 Extend `tools/service.mjs`: `GET /problems`, `POST /problems` (from task_id report or manual), `GET /problems/:id`, `PATCH /problems/:id` (title/description/triage/status/reason/change_ref), `POST /problems/:id/discussion`, reuse CORS/body-limit/redaction
- [x] 2.2 Add service tests: CRUD, create-from-report (diagnosed task), reject wontfix without reason, discussion redaction, 404/400 paths, non-localhost origin rejected

## 3. GitHub issue 集成

- [x] 3.1 Add `tools/github.mjs`: `createGithubIssue(problem, {repo, dryRun})` via `gh issue create` child process (repo from git remote, overridable); sanitized child env (reuse provider policy); issue body from buildChangeDraft + triage label; errors mapped to clear messages (gh unavailable / not logged in / non-zero exit)
- [x] 3.2 Add `POST /problems/:id/github` endpoint + tests (fake gh child: success writes github ref, failure returns error and keeps problem unchanged, dryRun no-op)
- [x] 3.3 Add `tools/github.test.mjs`: argv/body construction, env sanitization, exit-code mapping, no token in args/logs

## 4. 管理页面

- [x] 4.1 Add viewer problem view: list (badge/source/issue#/change_ref/filter by triage+status) and detail (report, triage, actions: submit issue / defer / wontfix / reopen / fixed / closed / change_ref, discussion list + input + turn-into-issue)
- [x] 4.2 Wire triage panel "创建问题" button (diagnosed terminal) → POST /problems → refresh list; CLI fallback when service unreachable
- [x] 4.3 Add viewer tests (problem-list/detail rendering, action flows, redaction) and bump cache-busting
- [x] 4.4 Update implementation.md + tasks.md checkboxes; run full verification (tools/viewer tests, `openspec validate --strict`, `./verify.sh`, credential scan)
