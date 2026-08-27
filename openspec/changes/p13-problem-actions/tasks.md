## 1. verify 下发

- [x] 1.1 Add `tools/actions.mjs`: `verifyProblem(problem, {command, markFixed, cwd, timeoutMs})` — command whitelist (cargo test / cargo build wasm / node --test tools/*.test.mjs / viewer tests / ./verify.sh with restricted args), timeout, tail-truncated + redacted output; returns {exit_code, summary}
- [x] 1.2 Add `POST /problems/:id/verify` endpoint (default command from report.verification first line; whitelist reject 400; decisions append; mark_fixed → status fixed) + tests (fake exec, whitelist, truncation, redaction, mark_fixed)

## 2. fix 下发

- [x] 2.1 Add fix orchestration in `tools/actions.mjs`: git worktree add (branch `fix/<id>/<ts>` from main), build fix prompt (phenomenon/root_cause/proposed_fix/verification/constraints), run provider adapter (bypass, sanitized env, structured output validation — extend runner's runDiagnosis skeleton to fix mode with schema {changed_files, summary, verification_results}), write back decisions + fix_ref (pending_confirm) + status in_progress; failures recorded, problem unchanged
- [x] 2.2 Add `POST /problems/:id/fix` endpoint + tests (fake provider: success writes fix_ref, failure no-op, whitelist env sanitization)

## 3. 确认闭环

- [x] 3.1 Add `POST /problems/:id/merge-fix`: require committed branch + verification record; merge into main checkout (--no-ff), push if origin configured, problem closed + change_ref, worktree cleanup; reject → fix_ref rejected (worktree kept); tests (fake git)
- [x] 3.2 Add viewer buttons: 验证 (+标记 fixed 选项), 修复, 确认合入; decisions/fix_ref rendering; cache-busting bump
- [x] 3.3 Update implementation.md + tasks.md; full verification (tools/viewer tests, `openspec validate --strict`, `./verify.sh`, credential scan)
