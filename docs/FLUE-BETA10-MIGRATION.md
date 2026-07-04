# Flue Migration Plan: beta.7 → beta.10 (direct, skip beta.8/beta.9)

> Status: **WAITING** — chờ 2 gate ở §1. Cập nhật 2026-07-04.
> Quyết định nền: pin `@flue/runtime@1.0.0-beta.7` cho tới khi cả 2 gate mở
> (xem `launch-readiness-review-2026-07-04.md` §9.2). Migrate MỘT lần, thẳng lên
> beta.10, TRƯỚC khi launch có traffic thật (store wipe đang miễn phí).

## 0. Tóm tắt breaking changes phải hấp thụ

Từ CHANGELOG `withastro/flue` (verified 2026-07-04, beta.9 là latest, beta.10 unreleased):

| Change | Bản | Đụng vào |
|---|---|---|
| `emitData()` + `data-*` parts **xóa, KHÔNG có replacement** (chỉ còn structured tool output) | beta.8 | `src/agents/hermes.ts:93,233`, `src/approval/index.ts:45,110-128`, `tests/approval-gate.test.ts` (5 chỗ), replay `handleData()` `src/app.ts:360-376,395` |
| Replay/offset bookkeeping + `agents.updates()` + client reducer xóa → `history()` (`FlueConversationSnapshot`) + `observe()` (live projection) | beta.8 | Stream proxy `src/app.ts:107-136` (`?offset=&live=`), long-poll client + `Stream-Next-Offset` header `src/app.ts:503-536` |
| Persisted store **schema v4 rồi v5, reset-only, không migration** (`PersistedSchemaVersionError`) | beta.8 + beta.10 | `FlueHermesAgent`, `FlueRegistry` DO storage (ApprovalDO/PrIndexDO KHÔNG bị — SQLite tự quản) |
| `dispatch()` nhận structured `DeliveredMessage` (`kind: 'user'` \| `'signal'`); wire body direct-agent đổi theo | beta.10 | `src/channels/github.ts` (qua `@flue/github`), mọi caller `POST /agents/hermes/:id` |
| `?wait=result` xóa; `client.agents.prompt()` xóa → `send()` + `wait()` + `history()`; `wait()` throw `FlueExecutionError` | beta.10 | Không dùng trực tiếp trong src/ (verify lại lúc migrate — grep `wait=result\|agents.prompt`) |
| Signal `tagName` validate theo XML naming rules | beta.10 | Tên signal mới nếu dùng `kind: 'signal'` |
| Message có typed `purpose`/`display` + optional `turnId` grouping | beta.10 | Replay renderer `handleEvent()` switch `src/app.ts:378-399` |
| Mới: `client.agents.abort()`, Anthropic qua AI Gateway bindings, `@flue/postgres\|libsql\|...` adapters | beta.8/9 | Cơ hội: wire abort route; không bắt buộc |

## 1. Gates — chỉ bấm nút khi đủ CẢ HAI

- [ ] **G1**: `@flue/runtime@1.0.0-beta.10` publish trên npm (check `npm view @flue/runtime versions`), và đọc lại CHANGELOG bản final — section Unreleased có thể đổi trước khi ship.
- [ ] **G2**: Có bản `@flue/github` tương thích wire format mới (beta.1 hiện tại nhiều khả năng không nói chuyện được với `DeliveredMessage`). Nếu 1 tuần sau beta.10 vẫn chưa có → mở issue hỏi withastro/flue, KHÔNG tự vá.

Nếu beta.10 trễ >3 tuần mà cần launch: launch trên beta.7 (đang work), migrate ngay sau launch — chi phí thêm duy nhất là mất replay của sessions cũ (chấp nhận được, ApprovalDO audit trail không mất).

## 2. Phase 0 — làm NGAY trên beta.7 (không cần chờ gate, ~0.5–1 ngày)

Mục tiêu: thu nhỏ blast radius để migration thật chỉ chạm 1 seam.
**Status: DONE 2026-07-04** (335 tests pass, typecheck + biome sạch; còn deploy + E2E verify).

- [x] **P0.a Decouple approval khỏi Flue stream** — ApprovalDO thành single source of truth:
  - `requireApproval()` đã bỏ nhánh `ctx.emitData` — dữ liệu y hệt đã nằm trong ApprovalDO
    qua `/request`. Giữ `trackApproval` observability.
  - Interface `ApprovalContext` chỉ còn `signal`; 2 call site trong `src/agents/hermes.ts`
    truyền `{ signal: ctx.signal }`.
  - `tests/approval-gate.test.ts` viết lại: assert qua `mockApprovalDO()` (capture `/request`
    body, fail ws-wait → timeout path cũng được cover).
- [x] **P0.b Replay UI đọc approvals từ DO, không từ data events**:
  - `pollApprovals()` thêm vào cả REPLAY_HTML inline (`src/app.ts`) lẫn bản tham chiếu
    `src/replay/index.html`: poll `GET /sessions/:id/approvals/open?token=` mỗi 4s, render
    approval mới, và khi approval pending biến mất khỏi open list → fetch `/approvals/:id`
    lấy decision thật rồi `resolveUI()`.
  - `handleData()` giữ lại như legacy fallback (đánh dấu comment) — xóa ở Phase 2.
- [x] **P0.c Seam stream đánh dấu `FLUE-STREAM-SEAM`**: tại route proxy `/sessions/:id/stream`
  và long-poll client trong replay HTML — chỗ DUY NHẤT đổi khi port sang `history()`/`observe()`.
- [ ] Deploy + verify E2E approval flow trên môi trường thật → merge.

Sau Phase 0: phần còn lại của migration không còn đụng approval flow nữa.

## 3. Phase 1 — Upgrade (khi gates mở, ~1–2 ngày)

- [ ] Branch `codex/flue-beta10`. Bump `@flue/runtime` → beta.10 exact, `@flue/github` → bản
  tương thích, chạy `npx flue build --target cloudflare`, sửa type errors.
- [ ] **Store wipe (schema v5)**: thêm wrangler migration tag `v3` với
  `deleted_classes` + `new_sqlite_classes` cho `FlueHermesAgent`, `FlueRegistry`
  (hoặc rename class) — sạch hơn là để runtime throw `PersistedSchemaVersionError`.
  ApprovalDO + PrIndexDO giữ nguyên, KHÔNG đụng migration của chúng.
- [ ] **Dispatch path**: verify `@flue/github` mới tự build `DeliveredMessage`; nếu channel
  handler signature đổi, cập nhật `src/channels/github.ts` (hiện chỉ log — 15 phút).
  Nếu có chỗ nào tự POST `/agents/hermes/:id` (tests/E2E), đổi body sang
  `DeliveredMessage {kind:'user'|'signal'}`; tên signal tuân XML naming.
- [ ] **Stream seam port** (chỗ đã đánh dấu ở P0.c): thay `?offset=&live=` bằng surface mới —
  ưu tiên dùng client SDK server-side (`history()` cho backfill + `observe()` pipe ra SSE/long-poll
  cho replay HTML), giữ nguyên contract `GET /sessions/:id/stream` với browser để HTML đổi tối thiểu.
  Cập nhật renderer nếu event names/shape đổi (`purpose`/`display`/`turnId` — app.ts:378-399).
- [ ] Verify `durability` options + `defineAgent`/`defineTool`/`registerProvider`/`cloudflareSandbox`
  signatures không đổi (đọc CHANGELOG final).
- [ ] Cơ hội nhân tiện (optional, chỉ nếu rẻ): wire `client.agents.abort()` vào route abort;
  route LLM qua AI Gateway binding để dùng spend limits.

## 4. Phase 2 — Verify & ship (~0.5–1 ngày)

- [ ] Unit + in-process DO tests xanh; workerd tests xanh.
- [ ] E2E thật trên staging: webhook giả → agent chạy → `git_push` chờ approval →
  approve qua replay UI → push + PR thành công; lặp lại với deny (check reason về model)
  và với container bị force-evict giữa chừng (dùng `evictDurableObject` helper mới của
  `cloudflare:test` cho ApprovalDO path).
- [ ] Replay UI: mở session mới, check timeline đủ turn/tool/approval; session cũ (pre-wipe)
  chấp nhận 404/empty — ghi rõ trong PR description.
- [ ] Rollback plan: revert commit + `wrangler deploy` (beta.7 code) — store mới tạo bởi beta.10
  sẽ bị beta.7 từ chối tương tự, nên rollback = fresh stores; chấp nhận được pre-launch.
  Sau launch: rollback window chỉ trong lúc chưa có session thật đang chạy.
- [ ] Cập nhật `docs/ARCHITECTURE.md` + review doc §9.2 (đổi status pin), xóa dead code
  `handleData` approval branch.

## 5. Không làm trong migration này

- KHÔNG gộp adopt Agents SDK / Workflows / MCP handler vào cùng PR — riêng biệt.
- KHÔNG nâng cấp @cloudflare/sandbox trong cùng PR (đã xử lý riêng theo deadline 09/07).
- KHÔNG build lại approval flow — Phase 0 đã tách nó khỏi Flue, migration không được đụng.

## 6. Effort tổng

| Phase | Effort | Khi nào |
|---|---|---|
| Phase 0 (decouple, trên beta.7) | 0.5–1 ngày | Ngay bây giờ |
| Phase 1 (upgrade) | 1–2 ngày | Khi G1+G2 mở |
| Phase 2 (verify) | 0.5–1 ngày | Liền sau Phase 1 |
