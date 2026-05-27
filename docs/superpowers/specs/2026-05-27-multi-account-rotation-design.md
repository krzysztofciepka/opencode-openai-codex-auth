# Multi-Account Rotation — Design

**Date:** 2026-05-27
**Status:** Approved (pre-implementation)
**Component:** `opencode-openai-codex-auth` plugin

## Summary

Extend the plugin so a user can configure multiple ChatGPT (Codex) accounts and
have the plugin transparently rotate between them based on usage limits. When the
active account crosses a usage threshold on its 5-hour window (default 90%), the
next turn is served by a different account — without resetting the opencode
session context. A hard usage-limit error triggers an immediate in-request
fallback to another account so the current turn still succeeds.

Context is preserved automatically because opencode resends the full conversation
`input` on every turn; the plugin only changes which account's OAuth token and
`chatgpt-account-id` are attached to the outgoing request. The switch happens at
the turn boundary (or as an in-request retry on hard failure), never mid-stream.

## Goals

- Configure multiple ChatGPT accounts and rotate automatically based on live usage.
- Proactively switch when the active account's 5h window reaches a configurable
  threshold (default 90%).
- React to hard usage-limit errors by retrying the same request on another account
  within the same `fetch` call, so the current turn survives a usage spike.
- Detect and exclude accounts that are no longer usable (revoked tokens, or a
  subscription that has lapsed to a free / non-paid plan).
- Preserve today's exact single-account behavior when only one account is present.

## Non-Goals (v1)

- No background daemon and no proactive polling of `GET /api/codex/usage`. Live
  rate-limit headers on each response are sufficient. (Polling to refresh
  cooled-down accounts without spending a turn is a possible later enhancement.)
- No model-picker / TUI UI for account management beyond toast notices.
- No automatic hard-deletion of accounts; removal is soft (tombstone) or manual.

## Background: verified platform facts

These facts were verified against the Codex backend behavior and the opencode SDK
shipped at `@opencode-ai/plugin@^1.0.150`.

- **Live usage signal.** Each Codex `/responses` (rewritten to `/codex/responses`)
  call returns rate-limit headers parsed by codex-rs into a snapshot:
  `x-codex-primary-used-percent`, `x-codex-primary-window-minutes`,
  `x-codex-primary-reset-after-seconds`, and the `secondary-*` equivalents.
  - `primary` ≈ the 5-hour window (`window_minutes ≈ 299`).
  - `secondary` ≈ the weekly window (`window_minutes ≈ 10079`).
  - Equivalent structured form (also seen in token_count events):
    `{ "primary": { "used_percent", "window_minutes", "resets_in_seconds" }, "secondary": {...} }`.
- **Plan signal.** The OAuth JWT's `https://api.openai.com/auth` claim carries
  `chatgpt_account_id`, `chatgpt_user_id`, and `chatgpt_plan_type`
  (`free` | `plus` | `pro` | `team` | `business` | `enterprise`).
  - Known OpenAI bug: `chatgpt_plan_type` is sometimes **missing** from the claim,
    causing paid accounts (Team/Pro) to be misdetected as Free. Therefore a
    *missing* plan claim must never be treated as free.
- **Notice mechanism.** `client.tui.showToast({ title?, message, variant, duration? })`
  exists (`variant: "info" | "success" | "warning" | "error"`). It is a TUI
  feature and may be a no-op/error in headless contexts, so calls are wrapped in
  try/catch and always accompanied by a log line.
- **Auth storage.** opencode stores a single credential per provider, keyed by
  provider id `openai`, read via `getAuth()` and written via
  `client.auth.set({ path: { id: "openai" }, body: {...} })`. Multi-account state
  therefore lives in a plugin-owned file, with the active account mirrored back
  into opencode's slot.

## Architecture

A new isolated module `lib/accounts/` owns all multi-account state and policy. The
two existing integration seams in `index.ts` delegate to it:

1. The OAuth `authorize` callbacks call the manager to **capture** each login.
2. The custom `fetch` calls the manager to **select** an account per request and to
   **record** usage from each response.

Account resolution moves *into* `fetch`. Today the `loader` decodes the account ID
once at load time and the `fetch` closure reuses it; that single captured ID is
replaced by a per-request lookup against the pool, which is what makes rotation
possible.

### Modules

- **`lib/accounts/store.ts`** — persistence for the account pool file
  `~/.opencode/openai-codex-accounts.json`.
  - Atomic write (write temp file + rename), file mode `0600` (contains refresh
    tokens).
  - Re-read-before-mutate to tolerate multiple concurrent opencode sessions sharing
    the file. Last-writer-wins per account record is acceptable for v1.
  - Pure load/save/upsert/remove helpers; no policy.
- **`lib/accounts/usage.ts`** — `parseUsageHeaders(headers): UsageSnapshot | null`.
  Reads the `x-codex-primary-*` / `x-codex-secondary-*` headers and converts
  `reset-after-seconds` into an absolute `resetsAt` (epoch ms). Returns `null` when
  no usage headers are present (request still proceeds).
- **`lib/accounts/plan.ts`** — `classifyPlan(token): "paid" | "free" | "unknown"`.
  Decodes the JWT claim's `chatgpt_plan_type`; explicit free → `free`; a known paid
  value → `paid`; missing/unrecognized → `unknown` (never disabled proactively).
- **`lib/accounts/manager.ts`** — the policy layer:
  - `selectAccount()` — choose the account for the next request.
  - `recordResponseUsage(accountId, headers)` — update snapshot + cooldown.
  - `captureLogin(tokens)` — upsert an account on OAuth success.
  - `refreshAccount(account)` — per-account token refresh with failure handling.
  - `markInvalid(accountId, reason)` / `noteSwitch(...)` — state transitions + toast.

### Account record

```jsonc
{
  "id": "<chatgpt_account_id>",        // stable key; dedupes on re-login
  "label": "work",                      // optional, user-editable
  "priority": 1,                        // selection order; assigned on capture, editable
  "access": "<access_token>",
  "refresh": "<refresh_token>",
  "expires": 1750000000000,             // epoch ms
  "status": "healthy",                  // "healthy" | "cooldown" | "invalid"
  "invalidReason": null,                // "auth_failed" | "plan_ineligible" | null
  "statusAt": 1750000000000,            // when status last changed
  "cooldownUntil": null,                // epoch ms; set when over threshold / rate-limited
  "usage": {
    "primary":   { "usedPercent": 0, "windowMinutes": 299,   "resetsAt": 1750017940000 },
    "secondary": { "usedPercent": 0, "windowMinutes": 10079, "resetsAt": 1750351406000 },
    "updatedAt": 1750000000000
  }
}
```

### Account state machine

- **`healthy`** — eligible for selection.
- **`cooldown`** — temporarily over the threshold or rate-limited; auto-recovers once
  `now >= cooldownUntil` (derived from the window reset). Skipped for proactive
  selection, but **usable as a soonest-reset fallback** (its token still works).
- **`invalid`** — cannot serve requests; **always skipped, never a fallback**.
  - `auth_failed` — token refresh returned `invalid_grant` / 401.
  - `plan_ineligible` — account is on a free / non-paid plan (no Codex access).

Revival: capture-on-login upserts **by account id**, so re-running
`opencode auth login` for an account flips it back to `healthy`. For
`plan_ineligible`, the user must re-subscribe and then re-login.

## Data flow

### Per request (inside `fetch`)

1. **Select** active account via `selectAccount()`:
   - Iterate accounts by ascending `priority`; pick the first that is `healthy`
     (and, if `includeWeeklyWindow`, whose weekly window is also under threshold)
     and not in cooldown.
   - If none qualify, fall back to the **soonest-reset** account among `cooldown`
     accounts (lowest `cooldownUntil`).
   - If only `invalid` accounts remain, throw an auth-required error (surfaced to
     opencode).
2. **Refresh** the selected account's token if expired, using *its own* refresh
   token; persist the new tokens to the pool.
   - On `invalid_grant` / 401 → `markInvalid(id, "auth_failed")`, then re-run
     selection (the failed account is now skipped).
   - After a successful refresh, re-classify the plan; explicit free →
     `markInvalid(id, "plan_ineligible")` and re-run selection.
3. **Mirror** the selected account into opencode's `openai` slot via
   `client.auth.set`, but only when the selected account differs from the
   last-mirrored one (and after a token refresh), to avoid a write per turn. This
   keeps opencode's view consistent and is a no-op-equivalent to today when
   single-account.
4. **Send** the request with headers built from the selected account's
   `chatgpt-account-id` + bearer token (existing `createCodexHeaders`, fed the
   active account). Context is intact: opencode already included the full `input`.
5. **Record** usage: parse `x-codex-*` from the response via
   `recordResponseUsage`. If the 5h `usedPercent >= thresholdPercent`, set
   `cooldownUntil` from the primary window's `resetsAt` so the **next turn**
   selects a different account. (If `includeWeeklyWindow`, the weekly window
   crossing the threshold also triggers cooldown.)

### Switch triggers

- **Proactive (between turns).** Step 5 sets cooldown when the threshold is
  reached; the following turn's `selectAccount()` picks a different account.
- **Reactive (within the request).** The current lumped error detection
  (`mapUsageLimit404`) is split by error code:
  - `usage_limit_reached` / `rate_limit_exceeded` → put the account into
    `cooldown` and **retry the same request with the next selected account**, up to
    `maxFallbackAttempts` total attempts, before surfacing the error. This keeps the
    in-flight turn alive.
  - `usage_not_included` → `markInvalid(id, "plan_ineligible")`, switch away, do not
    retry the same account.

### Capture-on-login

Both OAuth callbacks (auto server flow and manual paste) currently call
`exchangeAuthorizationCode` and return a `TokenSuccess` to opencode. They will also
call `manager.captureLogin(tokens)`, which:

1. Decodes the token to read `chatgpt_account_id` and `chatgpt_plan_type`.
2. Upserts the account into the pool by id (new accounts get the next `priority`;
   re-login of an existing/tombstoned id resets it to `healthy` and refreshes
   tokens).
3. If the plan is explicitly free, the record is stored as
   `invalid:plan_ineligible` (so the user sees why it is excluded).

The `TokenSuccess` is still returned to opencode unchanged, so opencode's own slot
is populated as before.

### First-run migration

On the first `fetch` where the pool file is missing or empty, the manager seeds the
pool from opencode's current `openai` oauth credential (decoding it for id + plan).
Existing single-account users therefore keep working with no action, and rotation
engages automatically once they add a second account.

## Configuration

Rotation settings live in the existing `~/.opencode/openai-codex-auth-config.json`
(loaded by `lib/config.ts`). Secrets (tokens) live only in the separate pool file.

```jsonc
{
  "codexMode": true,
  "rotation": {
    "enabled": true,             // auto-on with 2+ accounts; false forces single-account
    "thresholdPercent": 90,      // 5h primary window switch threshold
    "includeWeeklyWindow": true, // also mark unavailable when weekly window is exhausted
    "maxFallbackAttempts": 3     // max accounts tried within one request on hard limit
  }
}
```

Defaults match v1 behavior: with `enabled` defaulting to true, a single account
behaves exactly like today (nothing to rotate to), and rotation begins the moment a
second account exists.

## Notices

On a switch, a move to cooldown, or a transition to invalid, the manager calls
`client.tui.showToast`, for example:

- `info`: "Switched to account #2 (work) — #1 hit 91% of its 5h limit."
- `warning`: "Account #1 disabled: plan no longer includes Codex. Re-subscribe and re-login."
- `error`: "All accounts are rate-limited; using #1 (resets in 12m)."

Every toast is mirrored to the existing logger, and the toast call is wrapped in
try/catch so headless / non-TUI sessions degrade to log-only.

## Error handling

- **Token refresh failure** (`invalid_grant`/401): tombstone `auth_failed`, switch,
  surface auth error only if no usable account remains.
- **Hard usage limit** (`usage_limit_reached`/`rate_limit_exceeded`): cooldown +
  bounded in-request retry on the next account.
- **Plan ineligible** (`usage_not_included` or explicit free plan claim): tombstone
  `plan_ineligible`, switch away.
- **No usable accounts**: surface the underlying rate-limit/auth error to opencode
  (existing 404→429 mapping is preserved for the rate-limit case).
- **Corrupt / unreadable pool file**: log a warning and fall back to opencode's
  single `openai` slot (today's behavior) rather than crashing.
- **Concurrent writers**: re-read-before-mutate + atomic rename; last-writer-wins per
  record.

## Testing (vitest, TDD)

- `usage.ts`: header parsing, `resets_in_seconds` → `resetsAt`, missing headers → null.
- `plan.ts`: explicit free → free; known paid → paid; missing/unknown claim → unknown
  (not disabled).
- `store.ts`: load/save round-trip, atomic write, `0600` mode, upsert dedupe by id,
  concurrent re-read-before-mutate.
- `manager.selectAccount`: priority order, cooldown skip, soonest-reset fallback,
  all-invalid → auth error, weekly-window gating when enabled.
- `manager.refreshAccount`: success persists tokens; `invalid_grant` → tombstone
  `auth_failed`; post-refresh free plan → tombstone `plan_ineligible`.
- `manager.captureLogin`: new upsert + priority assignment; re-login revives a
  tombstone; explicit-free capture stored as `plan_ineligible`.
- First-run seed migration from opencode's `openai` slot.
- `fetch`-level integration with a mock backend: proactive threshold-cross switches
  on the next call; `usage_limit_reached` triggers bounded in-request fallback retry;
  `usage_not_included` disables the account and switches.

## Open questions / future work

- Optional `GET /api/codex/usage` polling to recover cooled-down accounts without
  spending a turn.
- Optional account-management surface (list/label/reorder priority) beyond editing
  the pool file by hand.
