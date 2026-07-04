# Launch-Readiness Architecture Review — 2026-07-04 (post Flue migration)

> Thay thế `launch-readiness-review-2026-07-03.md` — bản cũ viết cho kiến trúc E2B + VPS
> launcher + OpenCode runner, đã bị thay bởi Flue + Cloudflare Containers (PR #55, #59).
> Tổng hợp từ 3 nhánh: (1) audit codebase hiện tại, (2) Cloudflare best practices
> 2025–2026, (3) OpenHands/OpenCode/Ramp/Codex/Jules/Cursor + Hermes gateway v0.18 docs.

## 1. Verdict

Kiến trúc hiện tại **đúng hướng, không cần rebuild**. Stack Worker router → Flue Agent DO
(SQLite) → Cloudflare Sandbox per-session → git branch làm durability layer trùng khớp
gần như 1:1 với pattern hội tụ của các reference architecture chính thức 2026
(cloudflare/vibesdk, Sentry flue-agents, Claude Managed Agents, Ramp Inspect). Cloudflare
còn chính thức định vị Flue chạy trên Agents SDK runtime (blog 17/06/2026) — chọn Flue là
đặt cược đúng.

HITL core đã wire xong sau PR #59: approval DO + hibernatable WS + snapshot/restore
container + replay UI. Grade: **A- về skeleton, D về auth** — cụ thể:

**Launch blockers (P0):**
1. **Không có auth trên 3 route mutating**: `POST /proxy/git-push`, `POST /proxy/create-pr`
   (`src/app.ts:38-85`) và `POST /approvals/:id` (`src/app.ts:149-165`). Bất kỳ ai gọi được
   Worker đều push code / tạo PR / hijack approval. `timingSafeEqual` đã có sẵn trong
   `src/core/secrets.ts:16` nhưng chưa dùng.
2. **Deadline 09/07/2026 (5 ngày)**: Sandbox SDK xóa HTTP/WS transport, `exposePort`,
   default sessions. Phải pin `@cloudflare/sandbox` ≥0.12.3, set `transport: 'rpc'`,
   `enableDefaultSession: false`.
3. **Chưa có outbound push tới Hermes**: `approval_requested` được emit vào event log
   (`src/approval/index.ts:112`) nhưng không có gì gửi nó tới gateway → user không bao giờ
   biết cần approve.
4. `WORKER_URL` hardcode `http://localhost:8799` trong `wrangler.jsonc:43` → replay/approval
   URL chết trong production.
5. Không có `SKILL.md` theo convention Hermes.

## 2. Những gì đã đúng (giữ nguyên)

- Snapshot-based container recovery quanh approval gate (`src/agents/hermes.ts:60-157`):
  patch trước khi chờ approval, restore nếu container bị evict — đúng nguyên tắc
  "sandbox disposable, git/patch là durability" của cả 4 hệ production tham chiếu.
- Hibernatable WS wait trong `ApprovalDurableObject` (`src/do/approval-do.ts:202-230`)
  + alarm timeout — DO ngủ trong lúc chờ, không tốn duration billing.
- Credential isolation: `GITHUB_WRITE_TOKEN` chỉ sống server-side, tool trong sandbox gọi
  qua `/proxy/*` — pattern chuẩn (Codex remove secrets trước agent phase, vibesdk egress
  proxy). Chỉ thiếu auth trên chính proxy đó (P0.1).
- Hardline + classifier 2 tầng (`src/approval/hardline.ts`, `classifier.ts`) — cùng triết lý
  hardline uncircumventable của chính Hermes agent.
- State machine 11 states sạch; HMAC webhook GitHub do @flue/github verify; 3 tầng test.

## 3. P0 — chặn launch

| # | Việc | Chi tiết |
|---|---|---|
| P0.1 | **Auth mọi mutating route** | Bearer secret (timing-safe, đã có helper) cho `/proxy/*` + `/approvals/:id`. Chuẩn hơn: Cloudflare **Access service tokens** (`CF-Access-Client-Id/Secret`) — pattern M2M chính thức cho MCP từ 26/06/2026. **KHÔNG dùng workers-oauth-provider** cho Hermes (bản review cũ khuyên sai): nó dành cho client động không tin cậy, từng dính 2 CVE 2025 (PKCE bypass, redirect_uri), thừa attack surface khi caller là 1 gateway pre-trusted. |
| P0.2 | **Sandbox SDK deprecation 09/07** | Pin ≥0.12.3, `transport: 'rpc'`, `enableDefaultSession: false` + session ID tường minh, `exposePort` → tunnels API. Migration guide: developers.cloudflare.com/sandbox/guides/2026-deprecation/. |
| P0.3 | **Push qua Hermes webhook adapter** | Route `deliver_only: true` (0 LLM token, sub-second): `POST http://gateway:8644/webhooks/<route>`, ký `X-Webhook-Signature` = HMAC-SHA256 hex của raw body, dedupe qua `X-Request-ID` (cache 1h), ≤30 req/min, body ≤1 MB. Events: `approval.requested`, `pr.created`, `session.failed`. Retry + backoff phía mình. |
| P0.4 | **Sửa WORKER_URL** | Bỏ khỏi `wrangler.jsonc` vars; production đặt qua secret hoặc derive từ request host. |
| P0.5 | **SKILL.md** | `~/.hermes/skills/<cat>/<name>/SKILL.md`, frontmatter `metadata.hermes.requires_toolsets`, pattern: start → trả task ID ngay → status khi hỏi → completion đến từ webhook. Gắn route webhook approval vào `skills:` để user reply approve/deny in-channel (agent-mode route). |
| P0.6 | **Approval idempotency + re-validate** | `approval-do.ts:154` UPDATE không check `status !== 'pending'` → decision sau ghi đè decision trước; trả 409 nếu đã decided. Và theo "Rules of Durable Objects": input gate chỉ bảo vệ storage await — sau mọi `await fetch()` external phải re-read state trước khi transition/append (`src/approval/index.ts:145-165` hiện chưa làm). |
| P0.7 | **MCP surface cho Hermes** | Streamable HTTP, **stateless** (`createMcpHandler`) — spec 2026-07-28 (ra sau 3 tuần) xóa protocol sessions + SSE resumability. Tools: `start_task`, `get_status`, `respond_approval(session_id, approval_id, grant|deny, reason?)`, `list_pending_approvals`. Mọi tool phải trả về <300 s (timeout Hermes, không extend được; progress notifications KHÔNG được forward). |

## 4. Thiết kế HITL end-to-end (cập nhật cho stack mới)

```
Tool (Flue agent)        ApprovalDO                  Hermes gateway              User
  requireApproval() ──▶ register(pending, alarm TTL)
  snapshot patch         │
  chờ WS (hibernate)     ├─▶ POST webhooks/<route> deliver_only ──▶ Telegram/Slack: "cần approve X"
                         │      (approval_id, session, tool, args tóm tắt, replay URL)
  user: "approve" ───────┼──────────────────────────────────────────────┘
  Hermes gọi MCP respond_approval ──▶ Worker (auth!) ──▶ DO: check pending → decide → wake WS
  tool resume: check container alive → restore snapshot nếu chết → tiếp tục / deny kèm reason
```

Nguyên tắc rút từ OSS (áp vào code hiện tại):
1. **Pending approval là data, không phải process state** (OpenHands V1: pending = action
   chưa có observation, sống trong event log → restart-proof). ApprovalDO SQLite đã đúng
   hướng; đảm bảo approval events cũng vào Flue event log để replay/amend sạch.
2. **Deny phải kèm reason và feed lại model** (OpenHands `UserRejectObservation`, OpenCode
   `CorrectedError`) — deny không kill session, loop tiếp tục với feedback.
3. **"Always allow" policy sống ở DO/D1, không in-memory** (OpenCode v1 mất "always" sau
   restart — v2 mới persist; mình phải persist từ đầu).
4. **Elicitation Hermes v0.18 (01/07/2026) đã chính thức hỗ trợ** — form-mode, route qua
   approval system tới đúng surface của user, 300 s, fail-closed. Dùng làm đường phụ cho
   approval nhanh khi tool call đang in-flight; webhook vẫn là đường chính (background task
   thường vượt 300 s).
5. **Timeout approval**: giữ alarm hiện tại, nhưng thay vì auto-deny sớm → gửi reminder
   webhook; sandbox đã sleep tự động (`sleepAfter`) nên chờ lâu gần như miễn phí
   (idle-awake standard-1 ≈ $0.011/hr, sleep = $0).
6. **Follow-up serialize**: queue (Ramp) hoặc 409 busy (Cursor) — không concurrent steering.

## 5. Lệch Cloudflare best practices (sửa có chọn lọc)

| Vấn đề | Best practice | Mức |
|---|---|---|
| Deploy giết sandbox đang chạy | `wrangler deploy` rollout SIGTERM containers. Set `rollout_active_grace_period` (300–900 s) + checkpoint `createBackup('/workspace')` khi nhận SIGTERM | P1 |
| DO SQLite billing (live 07/01/2026) | Index đường truy cập event log, batch insert không xen `await`, `storage.deleteAll()` khi teardown session (compat ≥2026-02-24, xóa cả alarm) | P1 |
| Sandbox SDK bugs đang mở | #794 tạo concurrent fail + orphan billing containers → serialize creation + orphan reaper; #803 không có fleet-list API → tự giữ sandbox registry trong DO | P1 |
| Chờ approval dài | Không cần keep-alive — để sandbox sleep, restore từ snapshot khi resume (đã có). `keepAlive: true` chỉ khi chắc chắn resume <10 phút | P2 |
| PR-index singleton DO | Ceiling ~500–1000 rps; migrate D1 + Sessions API khi multi-user | P2 |
| Rate limit `/approvals/:id` | Leaky bucket per approval_id hoặc dựa vào 409-after-decided (P0.6 đã chặn phần lớn) | P2 |
| Feature-flag kill switches | Infra có sẵn (`core/feature-flags.ts`) nhưng chỉ APPROVAL_MODE được đọc → thêm `FF_AGENT_ENABLED`, `FF_GIT_PUSH_DISABLED` | P2 |

## 6. P1 — ngay sau launch

- **Approval policy per-user/per-repo** persist ở DO/D1 (§4.3); audit trail immutable.
- **Deny-with-reason** wire vào tool result (§4.2) nếu chưa có.
- **Rollout grace + SIGTERM checkpoint** (§5 dòng 1) — trước khi deploy thường xuyên.
- **Tests cho auth**: `POST /proxy/git-push` không token → 401, double-decide → 409.
- **R2 lifecycle rule** purge backup hết hạn (Backups API TTL 3 ngày nhưng object không tự xóa).
- Flue: **pin cứng `1.0.0-beta.7` cho tới sau launch** — xem §9.2, beta.8 là breaking release
  trúng thẳng vào surface mình đang dùng (`emitData()` bị xóa, store schema v4 reset).
- OAuth cho multi-user: PR bằng token user thật (Ramp: chặn self-approve PR của chính mình).

## 7. P2 — chiến lược

- **Workflows làm lifecycle skeleton**: provision → exec steps → backup → `waitForEvent("approval")`
  (buffer event đến sớm — không race, max 365 ngày, waiting = $0 CPU) → PR → cleanup.
  DO giữ vai trò ledger + WS streamer + forward decision vào `sendEvent()`. Chỉ làm khi
  lifecycle phức tạp hơn (multi-step plan, amend loop dài) — DO gate hiện tại đủ cho launch.
- **Agents SDK adoption incremental** (`Agent extends DurableObject`) — bắt đầu từ
  `McpAgent`/`createMcpHandler` và `this.schedule()`; tránh Project Think/fibers (preview).
- **DO Facets** (beta 04/2026) nếu cần isolate SQLite per sub-concern trong session DO.
- PR-index → D1 + Sessions API; dashboard đọc từ replica.
- Commit attribution configurable (Jules 3 modes: bot-only / co-authored / user-only).

## 8. Checklist launch (thứ tự thực thi)

1. [ ] P0.2 Sandbox SDK migration (deadline 09/07 — làm trước tiên)
2. [ ] P0.1 Auth bearer/Access trên `/proxy/*`, `/approvals/:id`
3. [ ] P0.4 WORKER_URL
4. [ ] P0.6 Approval 409 + re-validate sau external await
5. [ ] P0.3 Outbound webhook Hermes (deliver_only + HMAC + retry)
6. [ ] P0.7 MCP stateless handler + respond_approval/list_pending_approvals
7. [ ] P0.5 SKILL.md + agent-mode approval route
8. [ ] P1 items theo §6

## 9. Delta sweep 15/05 – 04/07/2026 (Cloudflare / Flue / Sandbox mới nhất)

### 9.1 Tools/features mới hữu ích cho control plane

| Feature | Ship | Áp dụng |
|---|---|---|
| **Workflows saga rollbacks** — compensating handler per-step, chạy ngược khi fail | 05–23/06 | Khi adopt Workflows (§7): "destroy sandbox, xóa branch" thành compensation thay vì cleanup step tự viết. blog.cloudflare.com/rollbacks-for-workflows/ |
| **Cron-scheduled Workflow instances** trong wrangler.jsonc | 02/06 | Reaper/maintenance job không cần cron-Worker riêng. |
| **`evictDurableObject` helper trong `cloudflare:test`** | 25/06 | Unit-test được hibernation/eviction path của ApprovalDO — nên thêm vào test suite (P1). |
| **`tracing.enterSpan()` custom spans** | 16/06 | Trace end-to-end Worker → DO → sandbox cho 1 agent run. |
| **AI Gateway spend limits** — hard budget theo model/provider/**custom metadata** | 05/06 | Cost cap per-run/per-tenant chống runaway loop — guardrail rẻ, nên bật khi route LLM qua AI Gateway. |
| **Agents SDK 0.16–0.17.3** — Code Mode exec có built-in approvals; typed action ledger idempotent; detached sub-agent runs | 16–30/06 | Overlap với HITL + idempotency layer tự viết — đánh giá trước khi build thêm phần của mình. |
| **MCP portal tool/prompt aliases** | 28/05 | Rename/re-describe tools tại portal — curate chính xác những gì Hermes thấy. |
| **Email Service authenticated SMTP (beta)** | 08/06 | Kênh phụ cho approval notification. |
| Dynamic Workers billing live ($0.002/Worker/ngày sau 1.000/tháng) | 26/05 | Nếu sau này dùng Worker Loader isolates cho snippet execution. |

Vẫn beta, **chưa build production path**: DO Facets, Dynamic Workflows (0.1.1 đóng băng),
`@cloudflare/codemode` 0.4.2, `@cloudflare/think`, `@cloudflare/shell`.

### 9.2 Flue — correction + cảnh báo nâng cấp

- **Correction**: Flue KHÔNG phải của Cloudflare — là dự án của Astro team
  (`github.com/withastro/flue`, Pi harness `earendil-works/pi`). Blog 17/06 của Cloudflare
  chỉ nói Agents SDK là runtime mà Flue target (mỗi Flue agent = 1 DO).
- Latest: `@flue/runtime` **1.0.0-beta.9** (30/06); `@flue/github` beta.1 vẫn là bản duy nhất.
- **beta.8 (29/06) breaking nặng, trúng thẳng code mình**: store schema v4 **reset không
  migration** (wipe persisted stores); **`emitData()`/`data-*` parts bị XÓA** (đang dùng ở
  `src/approval/index.ts:112`); replay/offset API thay bằng `history()` →
  `FlueConversationSnapshot` + `observe()` projection; custom PersistenceAdapter phải thêm
  `conversationStreamStore` + `attachmentStore`. beta.10 sắp ra còn breaking tiếp (schema v5,
  bỏ `?wait=result`, `client.agents.prompt()`).
- Flue **không có HITL primitive** và **không serve MCP** (chỉ consume) — layer approval +
  MCP surface của mình là tự xây thật sự, không có gì upstream để chờ.
- **Quyết định**: pin cứng beta.7, migrate MỘT lần thẳng lên beta.10 trước launch —
  plan chi tiết (gates, phases, blast radius theo file:line) ở
  [`FLUE-BETA10-MIGRATION.md`](./FLUE-BETA10-MIGRATION.md). Phase 0 (decouple approval
  khỏi `emitData` + stream seam) làm được ngay trên beta.7.

### 9.3 Sandbox/Containers

- 0.12.4 (sắp publish) thêm **`labels` trên SandboxOptions** → gắn session/run ID vào mọi
  sandbox, orphan reaper reconcile qua dashboard/analytics (mitigate #794 orphan billing +
  #803 không có fleet-list; cả 2 bug vẫn OPEN).
- **Full-disk `snapshot()` đã trượt** (12 tuần sau GA vẫn chưa ship) — kế hoạch warm-start/
  checkpoint xây **duy nhất trên `createBackup()`/`restoreBackup()`** (vừa được harden:
  restore sống qua DO restart #781). FUSE mounts không sống qua sleep.
- Deadline 09/07 giữ nguyên; 0.13.0 là removal release. Autoscaling containers vẫn "planned".
- Mới trong window: `ctx.container.exec()` (18/06), Google Artifact Registry images (01/07),
  budget alerts cho billable usage (04/06).

## 10. Nguồn

- Codebase: src/app.ts, src/agents/hermes.ts, src/approval/*, src/do/*, src/core/*,
  wrangler.jsonc, docs/ARCHITECTURE.md, docs/FLUE-MIGRATION-SPEC.md.
- Cloudflare: developers.cloudflare.com — sandbox/{api,guides/2026-deprecation}, containers/
  {platform-details,rollouts,pricing,limits}, durable-objects/best-practices/
  rules-of-durable-objects, workflows/build/events-and-parameters, agents/concepts/
  human-in-the-loop, agents/model-context-protocol/transport; changelog 2026-04-13 (GA),
  2026-06-09 (sandbox deprecations), 2026-06-26 (Access service tokens for MCP);
  blog.cloudflare.com — sandbox-ga, agents-platform-flue-sdk, workflows-v2, code-mode,
  claude-managed-agents, moltworker; github.com/cloudflare/{sandbox-sdk#794/#803, agents,
  vibesdk}; getsentry/flue-agents.
- OSS: OpenHands/software-agent-sdk (confirmation_policy.py, event tree, ConversationLease),
  OpenHands@0.62.0 (events/stream.py, security/), anomalyco/opencode v1.17 (sync layer,
  permission v2, PermissionSaved), builders.ramp.com background-agent, developers.openai.com/
  codex/cloud, developers.google.com/jules/api, cursor.com/docs/cloud-agent.
- Hermes v0.18.0 (01/07/2026): hermes-agent.nousresearch.com/docs — user-guide/messaging,
  webhooks, features/{mcp,skills,api-server}, security; NousResearch/hermes-agent
  (tools/mcp_tool.py — elicitation v0.18, no progress forwarding; webhook server 8644).
- MCP spec: modelcontextprotocol.io/specification/draft/changelog (2026-07-28 final).
