## 1. Observation Bundle

- [x] 1.1 Define the versioned observation bundle schema and the observation task status vocabulary (the task lifecycle is the state machine; the bundle itself has no `state` field)
- [x] 1.2 Add viewer capture controls for paused match time, natural-language statement, selected entities, and configurable before/after window
- [x] 1.3 Capture event, engine-derived, and viewer-frame evidence without exposing credentials
- [ ] 1.4 Add bundle export/import and deterministic replay tests (full seed/config rebuild is future work; export/import of the saved window is covered by 4.4 + observation tests)

## 2. Deterministic Audit

- [x] 2.1 Implement the audit interface, profile loading, finding schema, and deterministic result serialization
- [x] 2.2 Implement baseline invariant checks over an observation window
- [x] 2.3 Implement `unforced_out` detector with explicit dead-ball and tactical exclusions
- [x] 2.4 Implement `inactive_responsibility` detector with responsibility gating and static-duration evidence
- [x] 2.5 Implement `ignored_interception_opportunity` detector with pass-corridor and arrival-time features
- [x] 2.6 Add multi-seed aggregation for detector rates, sample counts, thresholds, and unknown reasons
- [x] 2.7 Add focused fixtures and regression tests for the three first detectors

## Slice 1 (2026-08-26) — tools bundle + detectors + tests

- [x] Add `tools/bundle.mjs`: `validateObservationBundle`, `redactCredentials`, `assertNoCredentials` (recursive; keys `ANTHROPIC_API_KEY`/`api_key`/`token`/`secret`/`authorization`; never leaks values in errors)
- [x] Add `tools/detectors.mjs`: `DEFAULT_AUDIT_PROFILE`, `runAudit(input, profile)` for `unforced_out`/`inactive_responsibility`/`ignored_interception_opportunity`; missing evidence => `unknown` with reason
- [x] Add focused Node tests (`tools/bundle.test.mjs`, `tools/detectors.test.mjs`) with fixture event arrays; no WASM / no Claude / no API calls

## 3. Local Diagnosis Runner

- [x] 3.1 Add local service or CLI entrypoint that accepts observation bundles and runs audit before diagnosis
- [x] 3.2 Add provider adapter interface and `ClaudeCodeAdapter` using the local `claude` executable
- [x] 3.3 Add provider/model/permission/budget/timeout configuration with `claude-code` as default
- [x] 3.4 Read `ANTHROPIC_API_KEY` only from the runner process environment and add redaction tests
- [x] 3.5 Add read-only diagnosis prompt, replay instructions, and structured JSON output validation
- [x] 3.6 Persist task status, raw output reference, structured report, errors, and retry metadata
- [x] 3.7 Add provider-unavailable, invalid-output, timeout, and insufficient-evidence tests

## Slice 2 (2026-08-26) — local diagnosis runner

- [x] Add `tools/runner.mjs`: `DEFAULT_RUNNER_CONFIG`, `buildDiagnosisPrompt`, `validateDiagnosisReport` (strict: field types, `hypotheses` string array, `confidence` in [0,1], JSON-text extraction), `redactTaskText`, `runDiagnosis` (validate bundle -> runAudit -> write audit report -> env gate -> provider -> validate -> persist; non-zero provider exit is error, never diagnosed)
- [x] Add `tools/provider.mjs`: `createProviderAdapter` + `ClaudeCodeAdapter`. Invokes local `claude -p --output-format text --input-format text --bare --permission-mode <mode>` (documented pipe form: `-p, --print` + prompt on stdin; no `-` stdin-sentinel positional); prompt delivered via stdin (ended; async stdin EPIPE guarded). Default read-only intent maps to `plan` + `--disallowedTools Edit Write NotebookEdit MultiEdit`; edit tools disallowed for any mode while `read_only`. Non-zero exit => error. `provider_unavailable` when key unset; key never in args/prompt/output. + `redactKey`
- [x] Add `tools/runner-cli.mjs`: dependency-free CLI entrypoint (`--bundle --audit --replay --revision --tasks-dir`, provider/model/permission/timeout/max-retry options, redacted task to stdout, status-based exit code)
- [x] Add `tools/runner.test.mjs`: 33 focused Node tests (provider unavailable; stdin prompt delivery + async EPIPE + non-benign stdin error; `--bare`/`plan`/`--disallowedTools` args + no key in args + read_only-mode independence; non-zero exit => error; runDiagnosis not diagnosed on non-zero exit/provider error; invalid output; adapter timeout via fake child; redaction/no credential leak; valid/insufficient_evidence reports; fenced-JSON extraction; null root_cause / non-array hypotheses / out-of-range confidence rejected). No real Claude/API calls.

## 4. Viewer Integration

- [x] 4.1 Add observation submission and diagnosis status display to the viewer
- [x] 4.2 Add finding markers and jump-to-evidence behavior on the match timeline
- [x] 4.3 Add diagnosis report display with root cause, code location, proposed fix, and verification command
- [x] 4.4 Preserve bundle download and CLI audit fallback when the local service is unavailable

## 5. Verification and Review

- [x] 5.1 Update viewer cache-busting version after JS/HTML changes
- [x] 5.2 Run targeted Rust and Node tests for observation, audit, and runner modules
- [x] 5.3 Run `./verify.sh` and OpenSpec validation
- [x] 5.4 Start an independent code-review agent and resolve all findings (final spec review round resolved)
- [ ] 5.5 Verify the original observation fixture end to end: capture, audit, diagnosis, report, and replay (service 端到端由 Slice 3 覆盖；真实 provider 诊断仍需用户带 key 验收，验收前不勾)

## 审阅修复 (2026-08-26) — 默认诊断权限改为 bypass

- [x] Change default diagnosis permission to bypass: `DEFAULT_RUNNER_CONFIG.permission='bypass'`、`read_only=false`（bypass 模式下不禁用编辑工具）；CLI usage/默认值与 help 文本同步；diagnosis prompt 措辞按权限模式区分（bypass = 可执行验证/复现命令与修改，read-only = plan + 禁编辑）；保留 `--permission read-only` 只读契约；更新 runner/provider 相关测试与 spec/docs（spec 已更新，见 diagnosis-runner "诊断 Agent 权限模式可配置，默认 bypass"）

## 审阅修复 (2026-08-26) — 服务支持 tailscale 网内访问

- [x] Add `--host` (default `127.0.0.1`, tailscale scenario passes `0.0.0.0`) and `--allow-origin <origin>` (repeatable) to `tools/service.mjs`; CORS echo requires localhost OR an allow-listed origin; update usage text; add tests (allow-listed origin echoed, non-whitelisted origin rejected, default still localhost-only); spec 已更新（diagnosis-runner "本地诊断服务" Requirement + 两个 Scenario）

## 审阅修复 (2026-08-26) — 页面端点随来源推导

- [x] Derive `OBSERVATION_ENDPOINT` from the page origin: hostname `localhost`/`127.0.0.1` → `http://127.0.0.1:8787`, otherwise `http://<hostname>:8787` (tailscale page auto-targets the service machine); implement as a pure testable function; bump cache-busting; spec 已更新（match-observation "页面提交使用本地诊断服务并回填结果" Requirement + tailscale Scenario）

## 审阅修复 (2026-08-27) — provider 子进程环境净化（真实诊断超时根因）

- [x] Sanitize the `claude` child process env in `tools/provider.mjs`: inherit base vars (PATH/HOME/TERM/LANG/SHELL etc.) + `ANTHROPIC_API_KEY` only; strip `CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_ENTRYPOINT`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*`, `AI_AGENT`, `CLAUDECODE`; env injectable for tests; tests assert child env carries no session vars and keeps the API key; spec 已更新（diagnosis-runner "provider 子进程环境净化" Requirement + 两个 Scenario）

## 审阅修复 (2026-08-27) — 诊断结果 triage 分流

- [x] Add `triage` to the diagnosis report contract: `validateDiagnosisReport` requires `triage.category` ∈ {bug, design, discuss} + non-empty `rationale` + `confidence` ∈ [0,1]; fallback to `{category:'discuss', rationale:'agent 未提供分类', confidence:0}` when missing/invalid (report not rejected); diagnosis prompt gains the classification guide (root-cause nature, not fix effort); viewer shows a triage badge + per-category next-step panel (bug → copy/download OpenSpec change draft built from report fields; design → open-question list; discuss → confirm-question list); tests for validation/fallback/prompt/draft builder; cache-busting bump; spec 已更新（diagnosis-runner "诊断报告包含 triage 分流" Requirement + 3 Scenario，design 4.5 节）

## Slice 3 (2026-08-26) — 本地诊断 HTTP 服务 + .env

- [x] Add dependency-free `.env` loader at CLI/service entry (repo root `.env`, `KEY=VALUE`, existing env wins, parse failure warns without exit, never logs values); commit `.env.example`, add `.env` to `.gitignore`
- [x] Add `tools/service.mjs`: localhost-only HTTP service — `POST /observations` (validate → audit → async diagnosis → `202 {task_id}`), `GET /tasks/:id` (redacted status/result polling), CORS echo only for localhost origins, body size limit, reuses `runDiagnosis` persistence
- [x] Add service tests without real API calls (request validation, credential rejection, task persistence + polling, CORS preflight/localhost-only echo, body size limit, non-localhost rejection)
- [x] Add viewer observation list: every capture/submit creates a list entry showing description, match moment, and live status badge (8-state machine) updated by polling; terminal states render the diagnosis feedback (root cause / code location / fix / verification / confidence) with findings red markers; list persists across reload (localStorage) and re-syncs status from the service; keep CLI fallback when unreachable
- [x] Bump cache-busting version, update implementation.md, run full verification (viewer/tools Node tests, `openspec validate --strict`, `./verify.sh`, credential scan)
