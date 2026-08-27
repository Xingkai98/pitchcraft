## 1. 服务端操作

- [x] 1.1 Add `deleteProblem(id, ctx)` to `tools/problems.mjs` (idempotent 404 semantics) + tests
- [x] 1.2 Add `POST /problems/:id/rerun` to `tools/service.mjs`: read bundle from source.task_id, async runDiagnosis (new runId, 202 + task_id), update problem source.task_id + decisions rerun; no bundle → 400; tests with fake runDiagnosis
- [x] 1.3 Add `POST /problems/import` to `tools/service.mjs`: scan diagnosed tasks (or explicit task_ids), skip tasks already linked to a Problem, return {created, skipped, failed}; tests (dedupe, explicit list, invalid task_id)
- [x] 1.4 Add `DELETE /problems/:id` endpoint + tests (200/404)

## 2. Viewer

- [x] 2.1 Add rerun button (poll GET /tasks/:id then refresh detail), delete button (confirm + refresh list), import-history button (summary notice) to the problem view; bump cache-busting
- [x] 2.2 Add viewer tests (action construction, confirm flow, redaction) and update implementation.md + tasks.md; run full verification (tools/viewer tests, `openspec validate --strict`, `./verify.sh`, credential scan)
