# Multi-Account Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user configure multiple ChatGPT (Codex) accounts and have the plugin transparently rotate between them based on the 5h usage window, without resetting opencode session context.

**Architecture:** A new isolated `lib/accounts/` module owns all multi-account state (a pool file + selection/refresh/capture policy). A standalone `rotatingFetch` orchestration loop coordinates the manager with the actual HTTP send and the reactive hard-limit fallback. `index.ts` wires the manager into the OAuth `authorize` callbacks (capture-on-login) and the custom `fetch` (per-request selection + post-response usage recording). Account resolution moves from a one-time decode in the loader to a per-request lookup, which is what makes rotation possible.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, Node `fs`/`os`/`path`, `@opencode-ai/plugin` + `@opencode-ai/sdk`.

**Spec:** `docs/superpowers/specs/2026-05-27-multi-account-rotation-design.md`

**Conventions for every task:**
- Run tests with `npm test` (vitest, `globals: true` — `describe`/`it`/`expect` are global; existing tests still `import` them, match the file you create to its neighbors).
- Typecheck with `npm run typecheck`.
- ESM: all intra-repo imports use the `.js` extension (e.g. `from "../types.js"`), even from `.ts` files.
- Commit after each task with the shown message.

---

## Task 1: Types & constants foundation

**Files:**
- Modify: `lib/types.ts`
- Modify: `lib/constants.ts`

- [ ] **Step 1: Extend `JWTPayload` and `PluginConfig`, add account types in `lib/types.ts`**

Find the existing `JWTPayload` interface and replace it with:

```ts
/**
 * JWT payload with ChatGPT account info
 */
export interface JWTPayload {
	"https://api.openai.com/auth"?: {
		chatgpt_account_id?: string;
		chatgpt_user_id?: string;
		chatgpt_plan_type?: string;
	};
	[key: string]: unknown;
}
```

Find the existing `PluginConfig` interface and replace it with:

```ts
/**
 * Plugin configuration from ~/.opencode/openai-codex-auth-config.json
 */
export interface PluginConfig {
	/**
	 * Enable CODEX_MODE (Codex-OpenCode bridge prompt instead of tool remap)
	 * @default true
	 */
	codexMode?: boolean;

	/** Multi-account rotation settings (partial; merged with defaults) */
	rotation?: Partial<RotationConfig>;
}
```

Append these new types to the end of `lib/types.ts` (before the final `// Re-export SDK types` block):

```ts
/** Classification of a ChatGPT plan from the JWT `chatgpt_plan_type` claim */
export type PlanClass = "paid" | "free" | "unknown";

/** Resolved multi-account rotation settings */
export interface RotationConfig {
	/** When false, behaves as single-account (no rotation). Auto-on with 2+ accounts. */
	enabled: boolean;
	/** 5h primary-window used-percent at which to switch accounts */
	thresholdPercent: number;
	/** Also treat an account unavailable when its weekly window is exhausted */
	includeWeeklyWindow: boolean;
	/** Max backend sends within one request when falling back on a hard limit */
	maxFallbackAttempts: number;
}

/** Usage for a single rate-limit window (5h primary or weekly secondary) */
export interface WindowUsage {
	usedPercent: number;
	windowMinutes: number;
	/** Absolute epoch-ms time when this window resets */
	resetsAt: number;
}

/** Snapshot of both rate-limit windows parsed from a response */
export interface UsageSnapshot {
	primary?: WindowUsage;
	secondary?: WindowUsage;
	/** epoch-ms when this snapshot was recorded */
	updatedAt: number;
}

/** Lifecycle status of a pooled account */
export type AccountStatus = "healthy" | "cooldown" | "invalid";

/** Reason an account is `invalid` */
export type InvalidReason = "auth_failed" | "plan_ineligible";

/** One ChatGPT account in the rotation pool */
export interface AccountRecord {
	/** chatgpt_account_id — stable key, dedupes on re-login */
	id: string;
	label?: string;
	/** selection order; lower wins */
	priority: number;
	access: string;
	refresh: string;
	/** epoch-ms expiry of the access token */
	expires: number;
	status: AccountStatus;
	invalidReason?: InvalidReason | null;
	/** epoch-ms when status last changed */
	statusAt: number;
	/** epoch-ms until which the account is rate-limited (cooldown) */
	cooldownUntil?: number | null;
	usage?: UsageSnapshot | null;
}

/** Persisted account pool file shape */
export interface AccountPool {
	version: 1;
	activeId?: string | null;
	accounts: AccountRecord[];
}
```

- [ ] **Step 2: Add constants in `lib/constants.ts`**

Append to the end of `lib/constants.ts`:

```ts
/** Codex rate-limit response headers (primary = 5h window, secondary = weekly) */
export const USAGE_HEADERS = {
	PRIMARY_USED_PERCENT: "x-codex-primary-used-percent",
	PRIMARY_WINDOW_MINUTES: "x-codex-primary-window-minutes",
	PRIMARY_RESET_SECONDS: "x-codex-primary-reset-after-seconds",
	SECONDARY_USED_PERCENT: "x-codex-secondary-used-percent",
	SECONDARY_WINDOW_MINUTES: "x-codex-secondary-window-minutes",
	SECONDARY_RESET_SECONDS: "x-codex-secondary-reset-after-seconds",
} as const;

/** ChatGPT plan types that include Codex access */
export const PAID_PLAN_TYPES = [
	"plus",
	"pro",
	"team",
	"business",
	"enterprise",
] as const;

/** Substrings identifying usage-limit error responses, by kind */
export const USAGE_LIMIT_CODES = {
	/** Temporary — account is rate-limited and will recover at reset */
	RATE_LIMIT: ["usage_limit_reached", "rate_limit_exceeded"],
	/** Permanent until re-subscribe — plan does not include Codex */
	PLAN_INELIGIBLE: ["usage_not_included"],
} as const;

/** Default rotation settings (merged with user config) */
export const DEFAULT_ROTATION = {
	enabled: true,
	thresholdPercent: 90,
	includeWeeklyWindow: true,
	maxFallbackAttempts: 3,
} as const;

/** Fallback cooldown when a hard limit gives no reset hint (15 min) */
export const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

/** Additional error messages for rotation */
export const ROTATION_ERROR_MESSAGES = {
	NO_USABLE_ACCOUNTS:
		"All ChatGPT accounts are unavailable (invalid or exhausted). Run `opencode auth login` to add or re-authorize an account.",
} as const;
```

- [ ] **Step 3: Verify types compile**

Run: `npm run typecheck`
Expected: PASS (no errors). The new types are not yet referenced anywhere, which is fine.

- [ ] **Step 4: Commit**

```bash
git add lib/types.ts lib/constants.ts
git commit -m "feat: add account rotation types and constants"
```

---

## Task 2: Rotation config resolver

**Files:**
- Modify: `lib/config.ts`
- Test: `test/config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.ts` (inside the top-level `describe('Configuration Parsing', ...)` is fine, or add a new top-level `describe`). Add a new top-level block after the existing one, and add the import at the top of the file:

Add to the imports at the top:

```ts
import { getRotationConfig } from '../lib/config.js';
```

Add this block at the end of the file:

```ts
describe('getRotationConfig', () => {
	it('returns defaults when rotation is absent', () => {
		const cfg = getRotationConfig({ codexMode: true });
		expect(cfg).toEqual({
			enabled: true,
			thresholdPercent: 90,
			includeWeeklyWindow: true,
			maxFallbackAttempts: 3,
		});
	});

	it('merges partial user overrides over defaults', () => {
		const cfg = getRotationConfig({
			rotation: { thresholdPercent: 80, maxFallbackAttempts: 5 },
		});
		expect(cfg.thresholdPercent).toBe(80);
		expect(cfg.maxFallbackAttempts).toBe(5);
		expect(cfg.enabled).toBe(true);
		expect(cfg.includeWeeklyWindow).toBe(true);
	});

	it('respects enabled:false', () => {
		const cfg = getRotationConfig({ rotation: { enabled: false } });
		expect(cfg.enabled).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- config`
Expected: FAIL — `getRotationConfig` is not exported from `../lib/config.js`.

- [ ] **Step 3: Implement `getRotationConfig`**

Add the import at the top of `lib/config.ts`:

```ts
import { DEFAULT_ROTATION } from "./constants.js";
import type { PluginConfig, RotationConfig } from "./types.js";
```

(Replace the existing `import type { PluginConfig } from "./types.js";` line with the combined import above, and add the `DEFAULT_ROTATION` import.)

Append to the end of `lib/config.ts`:

```ts
/**
 * Resolve effective rotation settings by merging user config over defaults.
 * @param pluginConfig - Plugin configuration from file
 * @returns Fully-populated rotation config
 */
export function getRotationConfig(pluginConfig: PluginConfig): RotationConfig {
	const r = pluginConfig.rotation ?? {};
	return {
		enabled: r.enabled ?? DEFAULT_ROTATION.enabled,
		thresholdPercent: r.thresholdPercent ?? DEFAULT_ROTATION.thresholdPercent,
		includeWeeklyWindow:
			r.includeWeeklyWindow ?? DEFAULT_ROTATION.includeWeeklyWindow,
		maxFallbackAttempts:
			r.maxFallbackAttempts ?? DEFAULT_ROTATION.maxFallbackAttempts,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- config`
Expected: PASS (all `getRotationConfig` tests green, existing config tests still green).

- [ ] **Step 5: Commit**

```bash
git add lib/config.ts test/config.test.ts
git commit -m "feat: add getRotationConfig resolver"
```

---

## Task 3: Token plan classification (`lib/accounts/token.ts`)

**Files:**
- Create: `lib/accounts/token.ts`
- Test: `test/accounts-token.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/accounts-token.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyPlan, getAccountIdFromToken } from '../lib/accounts/token.js';

/** Build a fake JWT (header.payload.signature) with the given auth claim. */
function makeToken(auth: Record<string, unknown> | undefined): string {
	const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64');
	const payloadObj = auth ? { 'https://api.openai.com/auth': auth } : {};
	const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64');
	return `${header}.${payload}.sig`;
}

describe('classifyPlan', () => {
	it('classifies explicit free as "free"', () => {
		expect(classifyPlan(makeToken({ chatgpt_plan_type: 'free' }))).toBe('free');
	});

	it('classifies known paid plans as "paid"', () => {
		for (const plan of ['plus', 'pro', 'team', 'business', 'enterprise']) {
			expect(classifyPlan(makeToken({ chatgpt_plan_type: plan }))).toBe('paid');
		}
	});

	it('returns "unknown" when the plan claim is missing (never treat as free)', () => {
		expect(classifyPlan(makeToken({ chatgpt_account_id: 'acc_1' }))).toBe('unknown');
	});

	it('returns "unknown" for an unrecognized plan value', () => {
		expect(classifyPlan(makeToken({ chatgpt_plan_type: 'mystery' }))).toBe('unknown');
	});

	it('returns "unknown" for an undecodable token', () => {
		expect(classifyPlan('not-a-jwt')).toBe('unknown');
	});
});

describe('getAccountIdFromToken', () => {
	it('extracts chatgpt_account_id', () => {
		expect(getAccountIdFromToken(makeToken({ chatgpt_account_id: 'acc_42' }))).toBe('acc_42');
	});

	it('returns undefined when absent', () => {
		expect(getAccountIdFromToken(makeToken({}))).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- accounts-token`
Expected: FAIL — cannot resolve `../lib/accounts/token.js`.

- [ ] **Step 3: Implement `lib/accounts/token.ts`**

```ts
import { decodeJWT } from "../auth/auth.js";
import { JWT_CLAIM_PATH, PAID_PLAN_TYPES } from "../constants.js";
import type { PlanClass } from "../types.js";

/**
 * Classify a ChatGPT plan from an access/id token's auth claim.
 * A MISSING or unrecognized plan is "unknown" (never "free"), to avoid
 * wrongly disabling paid accounts affected by OpenAI's missing-claim bug.
 */
export function classifyPlan(token: string): PlanClass {
	const planType = decodeJWT(token)?.[JWT_CLAIM_PATH]?.chatgpt_plan_type;
	if (typeof planType !== "string" || planType.length === 0) return "unknown";
	const normalized = planType.toLowerCase();
	if (normalized === "free") return "free";
	if ((PAID_PLAN_TYPES as readonly string[]).includes(normalized)) return "paid";
	return "unknown";
}

/** Extract the chatgpt_account_id from a token, or undefined. */
export function getAccountIdFromToken(token: string): string | undefined {
	return decodeJWT(token)?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- accounts-token`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/accounts/token.ts test/accounts-token.test.ts
git commit -m "feat: add token plan classification"
```

---

## Task 4: Usage header parsing & threshold (`lib/accounts/usage.ts`)

**Files:**
- Create: `lib/accounts/usage.ts`
- Test: `test/accounts-usage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/accounts-usage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
	parseUsageHeaders,
	overThresholdResetsAt,
	classifyUsageLimitError,
} from '../lib/accounts/usage.js';
import type { RotationConfig } from '../lib/types.js';

const NOW = 1_000_000_000_000;
const config: RotationConfig = {
	enabled: true,
	thresholdPercent: 90,
	includeWeeklyWindow: true,
	maxFallbackAttempts: 3,
};

describe('parseUsageHeaders', () => {
	it('parses primary and secondary windows into absolute reset times', () => {
		const headers = new Headers({
			'x-codex-primary-used-percent': '91.5',
			'x-codex-primary-window-minutes': '299',
			'x-codex-primary-reset-after-seconds': '600',
			'x-codex-secondary-used-percent': '20',
			'x-codex-secondary-window-minutes': '10079',
			'x-codex-secondary-reset-after-seconds': '3600',
		});
		const snap = parseUsageHeaders(headers, NOW);
		expect(snap).not.toBeNull();
		expect(snap!.primary).toEqual({ usedPercent: 91.5, windowMinutes: 299, resetsAt: NOW + 600_000 });
		expect(snap!.secondary).toEqual({ usedPercent: 20, windowMinutes: 10079, resetsAt: NOW + 3_600_000 });
		expect(snap!.updatedAt).toBe(NOW);
	});

	it('returns null when no usage headers are present', () => {
		expect(parseUsageHeaders(new Headers({ 'content-type': 'text/event-stream' }), NOW)).toBeNull();
	});
});

describe('overThresholdResetsAt', () => {
	it('returns the primary reset time when primary is over threshold', () => {
		const snap = parseUsageHeaders(new Headers({
			'x-codex-primary-used-percent': '90',
			'x-codex-primary-reset-after-seconds': '100',
		}), NOW);
		expect(overThresholdResetsAt(snap, config)).toBe(NOW + 100_000);
	});

	it('returns null when under threshold', () => {
		const snap = parseUsageHeaders(new Headers({ 'x-codex-primary-used-percent': '50' }), NOW);
		expect(overThresholdResetsAt(snap, config)).toBeNull();
	});

	it('ignores the weekly window when includeWeeklyWindow is false', () => {
		const snap = parseUsageHeaders(new Headers({
			'x-codex-primary-used-percent': '10',
			'x-codex-secondary-used-percent': '99',
			'x-codex-secondary-reset-after-seconds': '50',
		}), NOW);
		expect(overThresholdResetsAt(snap, { ...config, includeWeeklyWindow: false })).toBeNull();
		expect(overThresholdResetsAt(snap, config)).toBe(NOW + 50_000);
	});
});

describe('classifyUsageLimitError', () => {
	it('classifies usage_not_included as plan_ineligible', () => {
		expect(classifyUsageLimitError('usage_not_included', '{}')).toBe('plan_ineligible');
	});

	it('classifies rate-limit codes as rate_limit', () => {
		expect(classifyUsageLimitError('usage_limit_reached', '')).toBe('rate_limit');
		expect(classifyUsageLimitError('rate_limit_exceeded', '')).toBe('rate_limit');
	});

	it('classifies a plain "usage limit" message as rate_limit', () => {
		expect(classifyUsageLimitError('', 'You have hit your usage limit')).toBe('rate_limit');
	});

	it('returns null for unrelated errors', () => {
		expect(classifyUsageLimitError('server_error', 'boom')).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- accounts-usage`
Expected: FAIL — cannot resolve `../lib/accounts/usage.js`.

- [ ] **Step 3: Implement `lib/accounts/usage.ts`**

```ts
import { USAGE_HEADERS, USAGE_LIMIT_CODES } from "../constants.js";
import type { RotationConfig, UsageSnapshot, WindowUsage } from "../types.js";

function parseWindow(
	headers: Headers,
	usedKey: string,
	windowKey: string,
	resetKey: string,
	now: number,
): WindowUsage | undefined {
	const usedRaw = headers.get(usedKey);
	if (usedRaw === null) return undefined;
	const usedPercent = Number.parseFloat(usedRaw);
	if (Number.isNaN(usedPercent)) return undefined;
	const windowMinutes = Number.parseInt(headers.get(windowKey) ?? "0", 10) || 0;
	const resetSeconds = Number.parseInt(headers.get(resetKey) ?? "0", 10) || 0;
	return { usedPercent, windowMinutes, resetsAt: now + resetSeconds * 1000 };
}

/**
 * Parse Codex rate-limit headers into a usage snapshot.
 * Returns null when no usage headers are present (request still proceeds).
 */
export function parseUsageHeaders(
	headers: Headers,
	now: number = Date.now(),
): UsageSnapshot | null {
	const primary = parseWindow(
		headers,
		USAGE_HEADERS.PRIMARY_USED_PERCENT,
		USAGE_HEADERS.PRIMARY_WINDOW_MINUTES,
		USAGE_HEADERS.PRIMARY_RESET_SECONDS,
		now,
	);
	const secondary = parseWindow(
		headers,
		USAGE_HEADERS.SECONDARY_USED_PERCENT,
		USAGE_HEADERS.SECONDARY_WINDOW_MINUTES,
		USAGE_HEADERS.SECONDARY_RESET_SECONDS,
		now,
	);
	if (!primary && !secondary) return null;
	return { primary, secondary, updatedAt: now };
}

/**
 * If any in-scope window is at/above threshold, return the soonest reset time
 * among those windows; otherwise null. The 5h primary always counts; the weekly
 * secondary counts only when includeWeeklyWindow is true.
 */
export function overThresholdResetsAt(
	snapshot: UsageSnapshot | null | undefined,
	config: RotationConfig,
): number | null {
	if (!snapshot) return null;
	const resets: number[] = [];
	if (snapshot.primary && snapshot.primary.usedPercent >= config.thresholdPercent) {
		resets.push(snapshot.primary.resetsAt);
	}
	if (
		config.includeWeeklyWindow &&
		snapshot.secondary &&
		snapshot.secondary.usedPercent >= config.thresholdPercent
	) {
		resets.push(snapshot.secondary.resetsAt);
	}
	return resets.length ? Math.min(...resets) : null;
}

/**
 * Classify a usage-limit error by its code/body text.
 * plan_ineligible is checked first so usage_not_included is not mistaken for a
 * recoverable rate limit.
 */
export function classifyUsageLimitError(
	code: string,
	text: string,
): "rate_limit" | "plan_ineligible" | null {
	const haystack = `${code} ${text}`.toLowerCase();
	if (USAGE_LIMIT_CODES.PLAN_INELIGIBLE.some((c) => haystack.includes(c))) {
		return "plan_ineligible";
	}
	if (
		USAGE_LIMIT_CODES.RATE_LIMIT.some((c) => haystack.includes(c)) ||
		haystack.includes("usage limit")
	) {
		return "rate_limit";
	}
	return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- accounts-usage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/accounts/usage.ts test/accounts-usage.test.ts
git commit -m "feat: add usage header parsing and limit classification"
```

---

## Task 5: Refactor `fetch-helpers` to reuse the classifier + expose inspection

**Files:**
- Modify: `lib/request/fetch-helpers.ts`
- Test: `test/fetch-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/fetch-helpers.test.ts`. First add `inspectUsageLimitResponse` to the import from fetch-helpers (extend the existing import list), then add this block at the end of the top-level `describe`:

```ts
	describe('inspectUsageLimitResponse', () => {
		it('returns plan_ineligible for usage_not_included on a 404', async () => {
			const res = new Response(JSON.stringify({ error: { code: 'usage_not_included' } }), { status: 404 });
			expect(await inspectUsageLimitResponse(res)).toBe('plan_ineligible');
		});

		it('returns rate_limit for usage_limit_reached on a 429', async () => {
			const res = new Response(JSON.stringify({ error: { type: 'usage_limit_reached' } }), { status: 429 });
			expect(await inspectUsageLimitResponse(res)).toBe('rate_limit');
		});

		it('returns null for non-usage errors', async () => {
			const res = new Response(JSON.stringify({ error: { code: 'server_error' } }), { status: 500 });
			expect(await inspectUsageLimitResponse(res)).toBeNull();
		});

		it('does not consume the original response body', async () => {
			const res = new Response(JSON.stringify({ error: { code: 'usage_not_included' } }), { status: 404 });
			await inspectUsageLimitResponse(res);
			await expect(res.text()).resolves.toContain('usage_not_included');
		});
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- fetch-helpers`
Expected: FAIL — `inspectUsageLimitResponse` is not exported.

- [ ] **Step 3: Refactor `mapUsageLimit404` and add `inspectUsageLimitResponse`**

In `lib/request/fetch-helpers.ts`, add to the imports:

```ts
import { classifyUsageLimitError } from "../accounts/usage.js";
```

Add a shared extractor and the inspector, and rewrite `mapUsageLimit404` to reuse the classifier. Replace the existing `mapUsageLimit404` function with:

```ts
/** Read the error code + raw text from a (cloned) response without consuming it. */
async function readErrorCode(response: Response): Promise<{ code: string; text: string }> {
	const clone = response.clone();
	let text = "";
	try {
		text = await clone.text();
	} catch {
		text = "";
	}
	let code = "";
	if (text) {
		try {
			const parsed = JSON.parse(text) as any;
			code = (parsed?.error?.code ?? parsed?.error?.type ?? "").toString();
		} catch {
			code = "";
		}
	}
	return { code, text };
}

/**
 * Inspect a non-ok response and classify it as a usage-limit error.
 * Used by the rotation loop to decide whether to fall back to another account.
 * Does NOT consume the response body (uses a clone).
 */
export async function inspectUsageLimitResponse(
	response: Response,
): Promise<"rate_limit" | "plan_ineligible" | null> {
	if (response.status !== HTTP_STATUS.NOT_FOUND && response.status !== HTTP_STATUS.TOO_MANY_REQUESTS) {
		return null;
	}
	const { code, text } = await readErrorCode(response);
	if (!text) return null;
	return classifyUsageLimitError(code, text);
}

async function mapUsageLimit404(response: Response): Promise<Response | null> {
	if (response.status !== HTTP_STATUS.NOT_FOUND) return null;

	const { code, text } = await readErrorCode(response);
	if (!text) return null;
	if (classifyUsageLimitError(code, text) === null) return null;

	const headers = new Headers(response.headers);
	return new Response(response.body, {
		status: HTTP_STATUS.TOO_MANY_REQUESTS,
		statusText: "Too Many Requests",
		headers,
	});
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- fetch-helpers`
Expected: PASS (new `inspectUsageLimitResponse` block green; existing `handleErrorResponse` 404→429 tests still green).

- [ ] **Step 5: Commit**

```bash
git add lib/request/fetch-helpers.ts test/fetch-helpers.test.ts
git commit -m "refactor: reuse usage-limit classifier and expose response inspector"
```

---

## Task 6: Account pool store (`lib/accounts/store.ts`)

**Files:**
- Create: `lib/accounts/store.ts`
- Test: `test/accounts-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/accounts-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore, emptyPool } from '../lib/accounts/store.js';
import type { AccountPool } from '../lib/types.js';

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'codex-accounts-'));
	path = join(dir, 'accounts.json');
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function sampleAccount(id: string) {
	return {
		id,
		priority: 1,
		access: 'a',
		refresh: 'r',
		expires: 0,
		status: 'healthy' as const,
		statusAt: 0,
		cooldownUntil: null,
		usage: null,
	};
}

describe('createFileStore', () => {
	it('returns an empty pool when the file does not exist', () => {
		const store = createFileStore(path);
		expect(store.read()).toEqual(emptyPool());
	});

	it('round-trips a written pool', () => {
		const store = createFileStore(path);
		const pool: AccountPool = { version: 1, activeId: 'acc_1', accounts: [sampleAccount('acc_1')] };
		store.write(pool);
		expect(store.read()).toEqual(pool);
		expect(existsSync(path)).toBe(true);
	});

	it('writes the file with 0600 permissions', () => {
		const store = createFileStore(path);
		store.write({ version: 1, activeId: null, accounts: [] });
		// On POSIX, the low 9 bits should be rw------- (0o600)
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it('returns an empty pool when the file is corrupt', () => {
		writeFileSync(path, '{ not valid json', 'utf-8');
		const store = createFileStore(path);
		expect(store.read()).toEqual(emptyPool());
	});

	it('re-reads from disk on each read (no stale cache)', () => {
		const store = createFileStore(path);
		store.write({ version: 1, activeId: null, accounts: [sampleAccount('acc_1')] });
		// Simulate another process writing the file
		writeFileSync(path, JSON.stringify({ version: 1, activeId: 'acc_2', accounts: [sampleAccount('acc_2')] }));
		expect(store.read().activeId).toBe('acc_2');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- accounts-store`
Expected: FAIL — cannot resolve `../lib/accounts/store.js`.

- [ ] **Step 3: Implement `lib/accounts/store.ts`**

```ts
import {
	readFileSync,
	writeFileSync,
	renameSync,
	existsSync,
	mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { PLUGIN_NAME } from "../constants.js";
import type { AccountPool } from "../types.js";

/** Path to the multi-account pool file (contains refresh tokens). */
export const ACCOUNTS_PATH = join(
	homedir(),
	".opencode",
	"openai-codex-accounts.json",
);

/** A fresh, empty pool. */
export function emptyPool(): AccountPool {
	return { version: 1, activeId: null, accounts: [] };
}

/** Read/write port over the on-disk account pool. */
export interface AccountStore {
	/** Read the current pool from disk (empty pool if missing/corrupt). */
	read(): AccountPool;
	/** Atomically persist the pool with 0600 permissions. */
	write(pool: AccountPool): void;
}

/**
 * File-backed account store. Reads re-read from disk every time so concurrent
 * opencode sessions sharing the file see each other's writes (last-writer-wins).
 */
export function createFileStore(path: string = ACCOUNTS_PATH): AccountStore {
	return {
		read(): AccountPool {
			if (!existsSync(path)) return emptyPool();
			try {
				const parsed = JSON.parse(readFileSync(path, "utf-8")) as AccountPool;
				if (!parsed || !Array.isArray(parsed.accounts)) return emptyPool();
				return { version: 1, activeId: parsed.activeId ?? null, accounts: parsed.accounts };
			} catch (error) {
				console.warn(
					`[${PLUGIN_NAME}] Failed to read account pool at ${path}:`,
					(error as Error).message,
				);
				return emptyPool();
			}
		},
		write(pool: AccountPool): void {
			const dir = dirname(path);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			const tmp = `${path}.${process.pid}.tmp`;
			// mode 0600 — file holds refresh tokens
			writeFileSync(tmp, JSON.stringify(pool, null, 2), { encoding: "utf-8", mode: 0o600 });
			renameSync(tmp, path);
		},
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- accounts-store`
Expected: PASS.

> Note: the `0600` permission assertion is POSIX-specific. The project's CI/dev environment is Linux, so this holds. If ever run on Windows, that one assertion would need an `os.platform()` guard.

- [ ] **Step 5: Commit**

```bash
git add lib/accounts/store.ts test/accounts-store.test.ts
git commit -m "feat: add file-backed account pool store"
```

---

## Task 7: NoUsableAccountError + manager selection (`lib/accounts/manager.ts`)

**Files:**
- Create: `lib/accounts/errors.ts`
- Create: `lib/accounts/manager.ts`
- Test: `test/accounts-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/accounts-manager.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAccountManager } from '../lib/accounts/manager.js';
import { NoUsableAccountError } from '../lib/accounts/errors.js';
import type { AccountPool, AccountRecord, RotationConfig, AccountStatus } from '../lib/types.js';

afterEach(() => {
	vi.restoreAllMocks();
});

const CONFIG: RotationConfig = {
	enabled: true,
	thresholdPercent: 90,
	includeWeeklyWindow: true,
	maxFallbackAttempts: 3,
};

/** In-memory store fake. */
function fakeStore(pool: AccountPool) {
	let current = pool;
	return {
		read: () => JSON.parse(JSON.stringify(current)) as AccountPool,
		write: (p: AccountPool) => { current = JSON.parse(JSON.stringify(p)); },
		_current: () => current,
	};
}

function acct(id: string, over: Partial<AccountRecord> = {}): AccountRecord {
	return {
		id, priority: 1, access: `acc-${id}`, refresh: `ref-${id}`, expires: Number.MAX_SAFE_INTEGER,
		status: 'healthy' as AccountStatus, invalidReason: null, statusAt: 0, cooldownUntil: null, usage: null,
		...over,
	};
}

function makeManager(pool: AccountPool, now = 1000, config = CONFIG) {
	const store = fakeStore(pool);
	const client = { auth: { set: vi.fn() }, tui: { showToast: vi.fn() } } as any;
	const refresh = vi.fn();
	const manager = createAccountManager({ store, config, refresh, client, now: () => now });
	return { manager, store, client, refresh };
}

describe('selectAccount', () => {
	it('picks the lowest-priority healthy account', () => {
		const pool: AccountPool = { version: 1, activeId: null, accounts: [
			acct('b', { priority: 2 }), acct('a', { priority: 1 }),
		] };
		const { manager } = makeManager(pool);
		expect(manager.selectAccount(new Set()).id).toBe('a');
	});

	it('skips excluded accounts', () => {
		const pool: AccountPool = { version: 1, activeId: null, accounts: [
			acct('a', { priority: 1 }), acct('b', { priority: 2 }),
		] };
		const { manager } = makeManager(pool);
		expect(manager.selectAccount(new Set(['a'])).id).toBe('b');
	});

	it('skips invalid accounts entirely', () => {
		const pool: AccountPool = { version: 1, activeId: null, accounts: [
			acct('a', { priority: 1, status: 'invalid', invalidReason: 'auth_failed' }),
			acct('b', { priority: 2 }),
		] };
		const { manager } = makeManager(pool);
		expect(manager.selectAccount(new Set()).id).toBe('b');
	});

	it('skips accounts still cooling down', () => {
		const pool: AccountPool = { version: 1, activeId: null, accounts: [
			acct('a', { priority: 1, status: 'cooldown', cooldownUntil: 5000 }),
			acct('b', { priority: 2 }),
		] };
		const { manager } = makeManager(pool, 1000);
		expect(manager.selectAccount(new Set()).id).toBe('b');
	});

	it('treats an expired cooldown as available again', () => {
		const pool: AccountPool = { version: 1, activeId: null, accounts: [
			acct('a', { priority: 1, status: 'cooldown', cooldownUntil: 500 }),
		] };
		const { manager } = makeManager(pool, 1000);
		expect(manager.selectAccount(new Set()).id).toBe('a');
	});

	it('falls back to the soonest-reset cooling account when none are healthy', () => {
		const pool: AccountPool = { version: 1, activeId: null, accounts: [
			acct('a', { priority: 1, status: 'cooldown', cooldownUntil: 9000 }),
			acct('b', { priority: 2, status: 'cooldown', cooldownUntil: 6000 }),
		] };
		const { manager } = makeManager(pool, 1000);
		expect(manager.selectAccount(new Set()).id).toBe('b');
	});

	it('throws NoUsableAccountError when only invalid/excluded remain', () => {
		const pool: AccountPool = { version: 1, activeId: null, accounts: [
			acct('a', { status: 'invalid', invalidReason: 'plan_ineligible' }),
		] };
		const { manager } = makeManager(pool);
		expect(() => manager.selectAccount(new Set())).toThrow(NoUsableAccountError);
	});

	it('when disabled, returns the active account regardless of cooldown', () => {
		const pool: AccountPool = { version: 1, activeId: 'a', accounts: [
			acct('a', { priority: 1, status: 'cooldown', cooldownUntil: 9999 }),
			acct('b', { priority: 2 }),
		] };
		const { manager } = makeManager(pool, 1000, { ...CONFIG, enabled: false });
		expect(manager.selectAccount(new Set()).id).toBe('a');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- accounts-manager`
Expected: FAIL — cannot resolve `../lib/accounts/manager.js` / `../lib/accounts/errors.js`.

- [ ] **Step 3: Implement `lib/accounts/errors.ts`**

```ts
/** Thrown when no account in the pool can serve a request. */
export class NoUsableAccountError extends Error {
	constructor(message = "No usable ChatGPT account available") {
		super(message);
		this.name = "NoUsableAccountError";
	}
}
```

- [ ] **Step 4: Implement `lib/accounts/manager.ts` (deps, ctor, helpers, `selectAccount`)**

```ts
import type { OpencodeClient } from "@opencode-ai/sdk";
import { logDebug, logWarn } from "../logger.js";
import type {
	AccountRecord,
	InvalidReason,
	RotationConfig,
	TokenResult,
} from "../types.js";
import type { AccountStore } from "./store.js";
import { NoUsableAccountError } from "./errors.js";

/** Dependencies injected into the account manager (all easily faked in tests). */
export interface ManagerDeps {
	store: AccountStore;
	config: RotationConfig;
	/** Refresh an access token from a refresh token (= auth.refreshAccessToken). */
	refresh: (refreshToken: string) => Promise<TokenResult>;
	/** Opencode client (auth.set for slot mirroring, tui.showToast for notices). */
	client: Pick<OpencodeClient, "auth"> & {
		tui?: { showToast?: (input: unknown) => unknown };
	};
	now?: () => number;
}

/** Public surface of the account manager. */
export interface AccountManager {
	selectAccount(exclude?: Set<string>): AccountRecord;
	ensureFreshToken(account: AccountRecord): Promise<AccountRecord | null>;
	recordResponseUsage(accountId: string, headers: Headers): void;
	markCooldownFromError(accountId: string): void;
	markInvalid(accountId: string, reason: InvalidReason): void;
	captureLogin(tokens: { access: string; refresh: string; expires: number }): void;
	seedFromAuth(auth: { type: string; access?: string; refresh?: string; expires?: number }): void;
	applyActive(account: AccountRecord): Promise<void>;
}

function isCoolingDown(account: AccountRecord, now: number): boolean {
	return (
		account.status === "cooldown" &&
		typeof account.cooldownUntil === "number" &&
		account.cooldownUntil > now
	);
}

export function createAccountManager(deps: ManagerDeps): AccountManager {
	const now = deps.now ?? (() => Date.now());

	function notify(message: string, variant: "info" | "warning" | "error") {
		if (variant === "info") logDebug(message);
		else logWarn(message);
		try {
			deps.client.tui?.showToast?.({
				title: "Codex account rotation",
				message,
				variant,
			});
		} catch {
			// TUI not available (headless) — log line above is sufficient.
		}
	}

	const manager: AccountManager = {
		selectAccount(exclude = new Set<string>()): AccountRecord {
			const pool = deps.store.read();
			const usable = pool.accounts.filter((a) => !exclude.has(a.id));

			if (!deps.config.enabled) {
				const active =
					usable.find((a) => a.id === pool.activeId) ?? usable[0];
				if (!active) throw new NoUsableAccountError();
				return active;
			}

			const notInvalid = usable.filter((a) => a.status !== "invalid");
			const t = now();
			const available = notInvalid.filter((a) => !isCoolingDown(a, t));
			if (available.length) {
				available.sort((a, b) => a.priority - b.priority);
				return available[0];
			}
			// All remaining are cooling down (token still works) — pick soonest reset.
			if (notInvalid.length) {
				notInvalid.sort(
					(a, b) => (a.cooldownUntil ?? 0) - (b.cooldownUntil ?? 0),
				);
				return notInvalid[0];
			}
			throw new NoUsableAccountError();
		},

		// Implemented in later tasks.
		async ensureFreshToken(account) {
			return account;
		},
		recordResponseUsage() {},
		markCooldownFromError() {},
		markInvalid() {},
		captureLogin() {},
		seedFromAuth() {},
		async applyActive() {},
	};

	// Keep `notify` referenced (used by later-task methods).
	void notify;

	return manager;
}
```

> The later tasks replace the stubbed methods (`ensureFreshToken`, `recordResponseUsage`, etc.) with real implementations. They are stubbed here only so the file typechecks and `selectAccount` can be tested in isolation.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- accounts-manager`
Expected: PASS (all `selectAccount` cases green).

- [ ] **Step 6: Commit**

```bash
git add lib/accounts/errors.ts lib/accounts/manager.ts test/accounts-manager.test.ts
git commit -m "feat: add account manager selection logic"
```

---

## Task 8: Manager `recordResponseUsage` + `markCooldownFromError` + `markInvalid`

**Files:**
- Modify: `lib/accounts/manager.ts`
- Test: `test/accounts-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/accounts-manager.test.ts`:

```ts
function headersWithPrimary(usedPercent: number, resetSeconds: number): Headers {
	return new Headers({
		'x-codex-primary-used-percent': String(usedPercent),
		'x-codex-primary-window-minutes': '299',
		'x-codex-primary-reset-after-seconds': String(resetSeconds),
	});
}

describe('recordResponseUsage', () => {
	it('sets cooldown when the 5h window is over threshold', () => {
		const pool: AccountPool = { version: 1, activeId: 'a', accounts: [acct('a')] };
		const { manager, store } = makeManager(pool, 1000);
		manager.recordResponseUsage('a', headersWithPrimary(91, 600));
		const saved = store._current().accounts[0];
		expect(saved.status).toBe('cooldown');
		expect(saved.cooldownUntil).toBe(1000 + 600_000);
		expect(saved.usage?.primary?.usedPercent).toBe(91);
	});

	it('records usage without cooldown when under threshold', () => {
		const pool: AccountPool = { version: 1, activeId: 'a', accounts: [acct('a')] };
		const { manager, store } = makeManager(pool, 1000);
		manager.recordResponseUsage('a', headersWithPrimary(40, 600));
		const saved = store._current().accounts[0];
		expect(saved.status).toBe('healthy');
		expect(saved.cooldownUntil).toBeNull();
	});

	it('recovers a cooling account that now reports under threshold', () => {
		const pool: AccountPool = { version: 1, activeId: 'a', accounts: [
			acct('a', { status: 'cooldown', cooldownUntil: 1 }),
		] };
		const { manager, store } = makeManager(pool, 1000);
		manager.recordResponseUsage('a', headersWithPrimary(10, 0));
		expect(store._current().accounts[0].status).toBe('healthy');
	});

	it('does nothing when there are no usage headers', () => {
		const pool: AccountPool = { version: 1, activeId: 'a', accounts: [acct('a')] };
		const { manager, store } = makeManager(pool, 1000);
		manager.recordResponseUsage('a', new Headers());
		expect(store._current().accounts[0].usage).toBeNull();
	});
});

describe('markCooldownFromError', () => {
	it('uses the last known reset time when available', () => {
		const pool: AccountPool = { version: 1, activeId: 'a', accounts: [
			acct('a', { usage: { primary: { usedPercent: 95, windowMinutes: 299, resetsAt: 9000 }, updatedAt: 0 } }),
		] };
		const { manager, store } = makeManager(pool, 1000);
		manager.markCooldownFromError('a');
		expect(store._current().accounts[0].cooldownUntil).toBe(9000);
		expect(store._current().accounts[0].status).toBe('cooldown');
	});

	it('falls back to a default cooldown when no reset hint exists', () => {
		const pool: AccountPool = { version: 1, activeId: 'a', accounts: [acct('a')] };
		const { manager, store } = makeManager(pool, 1000);
		manager.markCooldownFromError('a');
		expect(store._current().accounts[0].cooldownUntil).toBe(1000 + 15 * 60 * 1000);
	});
});

describe('markInvalid', () => {
	it('marks the account invalid with a reason and clears cooldown', () => {
		const pool: AccountPool = { version: 1, activeId: 'a', accounts: [
			acct('a', { status: 'cooldown', cooldownUntil: 5000 }),
		] };
		const { manager, store } = makeManager(pool, 1000);
		manager.markInvalid('a', 'plan_ineligible');
		const saved = store._current().accounts[0];
		expect(saved.status).toBe('invalid');
		expect(saved.invalidReason).toBe('plan_ineligible');
		expect(saved.cooldownUntil).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- accounts-manager`
Expected: FAIL — stubs do nothing; assertions about saved state fail.

- [ ] **Step 3: Implement the three methods**

In `lib/accounts/manager.ts`, add imports:

```ts
import { DEFAULT_COOLDOWN_MS } from "../constants.js";
import { overThresholdResetsAt, parseUsageHeaders } from "./usage.js";
```

Add a private mutation helper inside `createAccountManager` (above the `const manager` declaration):

```ts
	function mutate(
		accountId: string,
		fn: (account: AccountRecord) => void,
	): void {
		const pool = deps.store.read();
		const account = pool.accounts.find((a) => a.id === accountId);
		if (!account) return;
		fn(account);
		deps.store.write(pool);
	}
```

Replace the stubbed `recordResponseUsage`, `markCooldownFromError`, and `markInvalid` with:

```ts
		recordResponseUsage(accountId: string, headers: Headers): void {
			const snapshot = parseUsageHeaders(headers, now());
			if (!snapshot) return;
			mutate(accountId, (account) => {
				account.usage = snapshot;
				const resetsAt = overThresholdResetsAt(snapshot, deps.config);
				if (resetsAt !== null) {
					account.status = "cooldown";
					account.cooldownUntil = resetsAt;
					account.statusAt = now();
					notify(
						`Account ${account.label ?? account.id} hit ${snapshot.primary?.usedPercent ?? "?"}% of its 5h limit; switching on next turn.`,
						"info",
					);
				} else if (account.status === "cooldown") {
					account.status = "healthy";
					account.cooldownUntil = null;
					account.statusAt = now();
				}
			});
		},

		markCooldownFromError(accountId: string): void {
			mutate(accountId, (account) => {
				const fromUsage = account.usage?.primary?.resetsAt;
				account.status = "cooldown";
				account.cooldownUntil =
					typeof fromUsage === "number" && fromUsage > now()
						? fromUsage
						: now() + DEFAULT_COOLDOWN_MS;
				account.statusAt = now();
				notify(
					`Account ${account.label ?? account.id} is rate-limited; trying another account.`,
					"info",
				);
			});
		},

		markInvalid(accountId: string, reason: InvalidReason): void {
			mutate(accountId, (account) => {
				account.status = "invalid";
				account.invalidReason = reason;
				account.cooldownUntil = null;
				account.statusAt = now();
				const why =
					reason === "plan_ineligible"
						? "plan no longer includes Codex (re-subscribe and re-login)"
						: "authentication failed (re-login required)";
				notify(`Account ${account.label ?? account.id} disabled: ${why}.`, "warning");
			});
		},
```

Also remove the now-unnecessary `void notify;` line, since `notify` is now used by the methods above.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- accounts-manager`
Expected: PASS (all selection + recording + marking cases green).

- [ ] **Step 5: Commit**

```bash
git add lib/accounts/manager.ts test/accounts-manager.test.ts
git commit -m "feat: record usage and mark cooldown/invalid in account manager"
```

---

## Task 9: Manager `ensureFreshToken`

**Files:**
- Modify: `lib/accounts/manager.ts`
- Test: `test/accounts-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/accounts-manager.test.ts` (add this import at the top of the file with the others):

```ts
import * as tokenModule from '../lib/accounts/token.js';
```

Then append:

```ts
describe('ensureFreshToken', () => {
	it('returns the account unchanged when the token is still valid', async () => {
		const pool: AccountPool = { version: 1, activeId: 'a', accounts: [
			acct('a', { expires: 1000 + 60_000 }),
		] };
		const { manager, refresh } = makeManager(pool, 1000);
		const result = await manager.ensureFreshToken(pool.accounts[0]);
		expect(result?.access).toBe('acc-a');
		expect(refresh).not.toHaveBeenCalled();
	});

	it('refreshes an expired token and persists the new tokens', async () => {
		const pool: AccountPool = { version: 1, activeId: 'a', accounts: [
			acct('a', { expires: 0 }),
		] };
		const { manager, store, refresh } = makeManager(pool, 1000);
		refresh.mockResolvedValue({ type: 'success', access: 'new-a', refresh: 'new-r', expires: 999999 });
		vi.spyOn(tokenModule, 'classifyPlan').mockReturnValue('paid');

		const result = await manager.ensureFreshToken(pool.accounts[0]);

		expect(result?.access).toBe('new-a');
		expect(store._current().accounts[0].access).toBe('new-a');
		expect(store._current().accounts[0].expires).toBe(999999);
	});

	it('tombstones the account as auth_failed when refresh fails', async () => {
		const pool: AccountPool = { version: 1, activeId: 'a', accounts: [acct('a', { expires: 0 })] };
		const { manager, store, refresh } = makeManager(pool, 1000);
		refresh.mockResolvedValue({ type: 'failed' });

		const result = await manager.ensureFreshToken(pool.accounts[0]);

		expect(result).toBeNull();
		expect(store._current().accounts[0].status).toBe('invalid');
		expect(store._current().accounts[0].invalidReason).toBe('auth_failed');
	});

	it('tombstones as plan_ineligible when the refreshed token is a free plan', async () => {
		const pool: AccountPool = { version: 1, activeId: 'a', accounts: [acct('a', { expires: 0 })] };
		const { manager, store, refresh } = makeManager(pool, 1000);
		refresh.mockResolvedValue({ type: 'success', access: 'free-a', refresh: 'r', expires: 999999 });
		vi.spyOn(tokenModule, 'classifyPlan').mockReturnValue('free');

		const result = await manager.ensureFreshToken(pool.accounts[0]);

		expect(result).toBeNull();
		expect(store._current().accounts[0].status).toBe('invalid');
		expect(store._current().accounts[0].invalidReason).toBe('plan_ineligible');
	});
});
```

> Note: `vi.spyOn(tokenModule, 'classifyPlan')` requires the manager to call `classifyPlan` via the module import (it does — see implementation). Add `afterEach(() => vi.restoreAllMocks())` at the top of this test file if not already present.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- accounts-manager`
Expected: FAIL — `ensureFreshToken` stub returns the account unchanged, so the refresh/tombstone cases fail.

- [ ] **Step 3: Implement `ensureFreshToken`**

In `lib/accounts/manager.ts`, add the import:

```ts
import { classifyPlan } from "./token.js";
```

Replace the stubbed `ensureFreshToken` with:

```ts
		async ensureFreshToken(account: AccountRecord): Promise<AccountRecord | null> {
			if (account.expires > now()) return account;

			const result = await deps.refresh(account.refresh);
			if (result.type === "failed") {
				manager.markInvalid(account.id, "auth_failed");
				return null;
			}

			if (classifyPlan(result.access) === "free") {
				// Persist the new tokens first so a later re-check is accurate, then tombstone.
				mutate(account.id, (a) => {
					a.access = result.access;
					a.refresh = result.refresh;
					a.expires = result.expires;
				});
				manager.markInvalid(account.id, "plan_ineligible");
				return null;
			}

			let updated: AccountRecord | null = null;
			mutate(account.id, (a) => {
				a.access = result.access;
				a.refresh = result.refresh;
				a.expires = result.expires;
				a.status = "healthy";
				a.invalidReason = null;
				a.statusAt = now();
				updated = { ...a };
			});
			return updated;
		},
```

> `markInvalid` and `mutate` are defined earlier in the same closure, and `manager` is in scope (closed-over), so `manager.markInvalid(...)` resolves.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- accounts-manager`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/accounts/manager.ts test/accounts-manager.test.ts
git commit -m "feat: add per-account token refresh with tombstoning"
```

---

## Task 10: Manager `captureLogin` + `seedFromAuth`

**Files:**
- Modify: `lib/accounts/manager.ts`
- Test: `test/accounts-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/accounts-manager.test.ts`:

```ts
describe('captureLogin', () => {
	it('adds a new account with the next priority and sets it active if first', () => {
		const pool: AccountPool = { version: 1, activeId: null, accounts: [] };
		const { manager, store } = makeManager(pool, 1000);
		vi.spyOn(tokenModule, 'getAccountIdFromToken').mockReturnValue('acc_new');
		vi.spyOn(tokenModule, 'classifyPlan').mockReturnValue('paid');

		manager.captureLogin({ access: 'x', refresh: 'y', expires: 5 });

		const saved = store._current();
		expect(saved.accounts).toHaveLength(1);
		expect(saved.accounts[0].id).toBe('acc_new');
		expect(saved.accounts[0].priority).toBe(1);
		expect(saved.activeId).toBe('acc_new');
	});

	it('assigns the next priority for a second account', () => {
		const pool: AccountPool = { version: 1, activeId: 'acc_1', accounts: [acct('acc_1', { priority: 1 })] };
		const { manager, store } = makeManager(pool, 1000);
		vi.spyOn(tokenModule, 'getAccountIdFromToken').mockReturnValue('acc_2');
		vi.spyOn(tokenModule, 'classifyPlan').mockReturnValue('paid');

		manager.captureLogin({ access: 'x', refresh: 'y', expires: 5 });

		const added = store._current().accounts.find((a) => a.id === 'acc_2');
		expect(added?.priority).toBe(2);
	});

	it('revives a tombstoned account on re-login (by id)', () => {
		const pool: AccountPool = { version: 1, activeId: 'acc_1', accounts: [
			acct('acc_1', { status: 'invalid', invalidReason: 'auth_failed' }),
		] };
		const { manager, store } = makeManager(pool, 1000);
		vi.spyOn(tokenModule, 'getAccountIdFromToken').mockReturnValue('acc_1');
		vi.spyOn(tokenModule, 'classifyPlan').mockReturnValue('paid');

		manager.captureLogin({ access: 'fresh', refresh: 'fresh-r', expires: 50 });

		const saved = store._current().accounts[0];
		expect(saved.status).toBe('healthy');
		expect(saved.invalidReason).toBeNull();
		expect(saved.access).toBe('fresh');
	});

	it('stores an explicitly-free login as plan_ineligible', () => {
		const pool: AccountPool = { version: 1, activeId: null, accounts: [] };
		const { manager, store } = makeManager(pool, 1000);
		vi.spyOn(tokenModule, 'getAccountIdFromToken').mockReturnValue('acc_free');
		vi.spyOn(tokenModule, 'classifyPlan').mockReturnValue('free');

		manager.captureLogin({ access: 'x', refresh: 'y', expires: 5 });

		const saved = store._current().accounts[0];
		expect(saved.status).toBe('invalid');
		expect(saved.invalidReason).toBe('plan_ineligible');
	});

	it('ignores a token with no account id', () => {
		const pool: AccountPool = { version: 1, activeId: null, accounts: [] };
		const { manager, store } = makeManager(pool, 1000);
		vi.spyOn(tokenModule, 'getAccountIdFromToken').mockReturnValue(undefined);
		manager.captureLogin({ access: 'x', refresh: 'y', expires: 5 });
		expect(store._current().accounts).toHaveLength(0);
	});
});

describe('seedFromAuth', () => {
	it('seeds the pool from an oauth slot when empty', () => {
		const pool: AccountPool = { version: 1, activeId: null, accounts: [] };
		const { manager, store } = makeManager(pool, 1000);
		vi.spyOn(tokenModule, 'getAccountIdFromToken').mockReturnValue('acc_seed');
		vi.spyOn(tokenModule, 'classifyPlan').mockReturnValue('paid');

		manager.seedFromAuth({ type: 'oauth', access: 'a', refresh: 'r', expires: 9 });

		expect(store._current().accounts[0].id).toBe('acc_seed');
	});

	it('does nothing when the pool already has accounts', () => {
		const pool: AccountPool = { version: 1, activeId: 'acc_1', accounts: [acct('acc_1')] };
		const { manager, store } = makeManager(pool, 1000);
		manager.seedFromAuth({ type: 'oauth', access: 'a', refresh: 'r', expires: 9 });
		expect(store._current().accounts).toHaveLength(1);
	});

	it('does nothing for non-oauth auth', () => {
		const pool: AccountPool = { version: 1, activeId: null, accounts: [] };
		const { manager, store } = makeManager(pool, 1000);
		manager.seedFromAuth({ type: 'api' });
		expect(store._current().accounts).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- accounts-manager`
Expected: FAIL — `captureLogin`/`seedFromAuth` stubs do nothing.

- [ ] **Step 3: Implement `captureLogin` + `seedFromAuth`**

In `lib/accounts/manager.ts`, extend the token import:

```ts
import { classifyPlan, getAccountIdFromToken } from "./token.js";
```

Replace the stubbed `captureLogin` and `seedFromAuth` with:

```ts
		captureLogin(tokens: { access: string; refresh: string; expires: number }): void {
			const accountId = getAccountIdFromToken(tokens.access);
			if (!accountId) return;
			const free = classifyPlan(tokens.access) === "free";

			const pool = deps.store.read();
			let account = pool.accounts.find((a) => a.id === accountId);
			if (!account) {
				const priority = pool.accounts.length
					? Math.max(...pool.accounts.map((a) => a.priority)) + 1
					: 1;
				account = {
					id: accountId,
					priority,
					access: tokens.access,
					refresh: tokens.refresh,
					expires: tokens.expires,
					status: "healthy",
					invalidReason: null,
					statusAt: now(),
					cooldownUntil: null,
					usage: null,
				};
				pool.accounts.push(account);
			} else {
				account.access = tokens.access;
				account.refresh = tokens.refresh;
				account.expires = tokens.expires;
				account.status = "healthy";
				account.invalidReason = null;
				account.statusAt = now();
				account.cooldownUntil = null;
			}

			if (free) {
				account.status = "invalid";
				account.invalidReason = "plan_ineligible";
				account.statusAt = now();
			}
			if (!pool.activeId) pool.activeId = accountId;
			deps.store.write(pool);
		},

		seedFromAuth(auth): void {
			if (auth.type !== "oauth" || !auth.access || !auth.refresh) return;
			if (deps.store.read().accounts.length > 0) return;
			manager.captureLogin({
				access: auth.access,
				refresh: auth.refresh,
				expires: auth.expires ?? 0,
			});
		},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- accounts-manager`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/accounts/manager.ts test/accounts-manager.test.ts
git commit -m "feat: add capture-on-login and seed-from-auth to account manager"
```

---

## Task 11: Manager `applyActive` (mirror-on-change + switch notice)

**Files:**
- Modify: `lib/accounts/manager.ts`
- Test: `test/accounts-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/accounts-manager.test.ts`:

```ts
describe('applyActive', () => {
	it('mirrors the account into the opencode openai slot', async () => {
		const pool: AccountPool = { version: 1, activeId: 'a', accounts: [acct('a')] };
		const { manager, client } = makeManager(pool, 1000);
		await manager.applyActive(pool.accounts[0]);
		expect(client.auth.set).toHaveBeenCalledWith({
			path: { id: 'openai' },
			body: { type: 'oauth', access: 'acc-a', refresh: 'ref-a', expires: Number.MAX_SAFE_INTEGER },
		});
	});

	it('does not re-mirror the same account+token twice', async () => {
		const pool: AccountPool = { version: 1, activeId: 'a', accounts: [acct('a')] };
		const { manager, client } = makeManager(pool, 1000);
		await manager.applyActive(pool.accounts[0]);
		await manager.applyActive(pool.accounts[0]);
		expect(client.auth.set).toHaveBeenCalledTimes(1);
	});

	it('emits a switch toast and updates activeId when switching accounts', async () => {
		const pool: AccountPool = { version: 1, activeId: 'a', accounts: [acct('a'), acct('b', { priority: 2 })] };
		const { manager, client, store } = makeManager(pool, 1000);
		await manager.applyActive(pool.accounts[0]); // active = a (no switch toast, same as activeId)
		await manager.applyActive(pool.accounts[1]); // switch a -> b
		expect(store._current().activeId).toBe('b');
		expect(client.tui.showToast).toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- accounts-manager`
Expected: FAIL — `applyActive` stub does nothing.

- [ ] **Step 3: Implement `applyActive`**

In `lib/accounts/manager.ts`, add a closure-level variable to track the last mirrored credential. Place it just after `const now = ...`:

```ts
	let lastMirrored: { id: string; access: string } | null = null;
```

Replace the stubbed `applyActive` with:

```ts
		async applyActive(account: AccountRecord): Promise<void> {
			const pool = deps.store.read();
			const previousActiveId = pool.activeId ?? null;
			if (previousActiveId !== account.id) {
				pool.activeId = account.id;
				deps.store.write(pool);
				if (previousActiveId !== null) {
					const prev = pool.accounts.find((a) => a.id === previousActiveId);
					notify(
						`Switched to account ${account.label ?? account.id} (was ${prev?.label ?? previousActiveId}).`,
						"info",
					);
				}
			}
			if (lastMirrored?.id === account.id && lastMirrored.access === account.access) {
				return;
			}
			lastMirrored = { id: account.id, access: account.access };
			await deps.client.auth.set({
				path: { id: "openai" },
				body: {
					type: "oauth",
					access: account.access,
					refresh: account.refresh,
					expires: account.expires,
				},
			});
		},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- accounts-manager`
Expected: PASS.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. The manager is now feature-complete.

- [ ] **Step 6: Commit**

```bash
git add lib/accounts/manager.ts test/accounts-manager.test.ts
git commit -m "feat: mirror active account and emit switch notices"
```

---

## Task 12: Rotation orchestration loop (`lib/request/rotating-fetch.ts`)

**Files:**
- Create: `lib/request/rotating-fetch.ts`
- Test: `test/rotating-fetch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/rotating-fetch.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { rotatingFetch } from '../lib/request/rotating-fetch.js';
import { NoUsableAccountError } from '../lib/accounts/errors.js';
import type { AccountRecord, RotationConfig } from '../lib/types.js';

const CONFIG: RotationConfig = {
	enabled: true, thresholdPercent: 90, includeWeeklyWindow: true, maxFallbackAttempts: 3,
};

function acct(id: string): AccountRecord {
	return { id, priority: 1, access: `acc-${id}`, refresh: `r-${id}`, expires: Number.MAX_SAFE_INTEGER,
		status: 'healthy', invalidReason: null, statusAt: 0, cooldownUntil: null, usage: null };
}

/** Build a manager port that hands out the given accounts in order, skipping excluded ones. */
function fakeManager(order: string[], overrides: Partial<Record<string, any>> = {}) {
	const accounts = new Map(order.map((id) => [id, acct(id)]));
	return {
		selectAccount: vi.fn((exclude: Set<string>) => {
			const next = order.find((id) => !exclude.has(id));
			if (!next) throw new NoUsableAccountError();
			return accounts.get(next)!;
		}),
		ensureFreshToken: vi.fn(async (a: AccountRecord) => a),
		markCooldownFromError: vi.fn(),
		markInvalid: vi.fn(),
		...overrides,
	};
}

describe('rotatingFetch', () => {
	it('returns the first ok response without extra selection', async () => {
		const manager = fakeManager(['a', 'b']);
		const doFetch = vi.fn(async () => new Response('ok', { status: 200 }));
		const inspect = vi.fn(async () => null);

		const { account, response } = await rotatingFetch({ manager, config: CONFIG, doFetch, inspectUsageLimit: inspect });

		expect(account.id).toBe('a');
		expect(response.status).toBe(200);
		expect(doFetch).toHaveBeenCalledTimes(1);
	});

	it('falls back to the next account on a rate-limit error', async () => {
		const manager = fakeManager(['a', 'b']);
		const doFetch = vi.fn()
			.mockResolvedValueOnce(new Response('limit', { status: 429 }))
			.mockResolvedValueOnce(new Response('ok', { status: 200 }));
		const inspect = vi.fn(async () => 'rate_limit' as const);

		const { account, response } = await rotatingFetch({ manager, config: CONFIG, doFetch, inspectUsageLimit: inspect });

		expect(response.status).toBe(200);
		expect(account.id).toBe('b');
		expect(manager.markCooldownFromError).toHaveBeenCalledWith('a');
		expect(doFetch).toHaveBeenCalledTimes(2);
	});

	it('marks plan_ineligible and switches away', async () => {
		const manager = fakeManager(['a', 'b']);
		const doFetch = vi.fn()
			.mockResolvedValueOnce(new Response('nope', { status: 404 }))
			.mockResolvedValueOnce(new Response('ok', { status: 200 }));
		const inspect = vi.fn()
			.mockResolvedValueOnce('plan_ineligible' as const)
			.mockResolvedValueOnce(null);

		const { account } = await rotatingFetch({ manager, config: CONFIG, doFetch, inspectUsageLimit: inspect });

		expect(account.id).toBe('b');
		expect(manager.markInvalid).toHaveBeenCalledWith('a', 'plan_ineligible');
	});

	it('stops after maxFallbackAttempts sends and returns the last response', async () => {
		const manager = fakeManager(['a', 'b', 'c', 'd']);
		const doFetch = vi.fn(async () => new Response('limit', { status: 429 }));
		const inspect = vi.fn(async () => 'rate_limit' as const);

		const { response } = await rotatingFetch({
			manager, config: { ...CONFIG, maxFallbackAttempts: 2 }, doFetch, inspectUsageLimit: inspect,
		});

		expect(response.status).toBe(429);
		expect(doFetch).toHaveBeenCalledTimes(2);
	});

	it('skips an account whose refresh failed (no send) and tries the next', async () => {
		const manager = fakeManager(['a', 'b']);
		manager.ensureFreshToken = vi.fn()
			.mockResolvedValueOnce(null)            // 'a' refresh failed -> skip, no send
			.mockImplementationOnce(async (x) => x); // 'b' ok
		const doFetch = vi.fn(async () => new Response('ok', { status: 200 }));
		const inspect = vi.fn(async () => null);

		const { account } = await rotatingFetch({ manager, config: CONFIG, doFetch, inspectUsageLimit: inspect });

		expect(account.id).toBe('b');
		expect(doFetch).toHaveBeenCalledTimes(1);
	});

	it('propagates NoUsableAccountError when nothing was ever sent', async () => {
		const manager = fakeManager([]);
		const doFetch = vi.fn();
		const inspect = vi.fn();
		await expect(
			rotatingFetch({ manager, config: CONFIG, doFetch, inspectUsageLimit: inspect }),
		).rejects.toBeInstanceOf(NoUsableAccountError);
		expect(doFetch).not.toHaveBeenCalled();
	});

	it('surfaces a non-usage error immediately without retrying', async () => {
		const manager = fakeManager(['a', 'b']);
		const doFetch = vi.fn(async () => new Response('boom', { status: 500 }));
		const inspect = vi.fn(async () => null);

		const { response } = await rotatingFetch({ manager, config: CONFIG, doFetch, inspectUsageLimit: inspect });

		expect(response.status).toBe(500);
		expect(doFetch).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- rotating-fetch`
Expected: FAIL — cannot resolve `../lib/request/rotating-fetch.js`.

- [ ] **Step 3: Implement `lib/request/rotating-fetch.ts`**

```ts
import type { AccountRecord, RotationConfig } from "../types.js";
import { NoUsableAccountError } from "../accounts/errors.js";

/** Minimal manager surface the rotation loop depends on (satisfied by AccountManager). */
export interface RotationManagerPort {
	selectAccount(exclude: Set<string>): AccountRecord;
	ensureFreshToken(account: AccountRecord): Promise<AccountRecord | null>;
	markCooldownFromError(accountId: string): void;
	markInvalid(accountId: string, reason: "auth_failed" | "plan_ineligible"): void;
}

export interface RotatingFetchDeps {
	manager: RotationManagerPort;
	config: RotationConfig;
	/** Build headers for the given account and perform the actual HTTP send. */
	doFetch: (account: AccountRecord) => Promise<Response>;
	/** Classify a non-ok response as a usage-limit error (or null). */
	inspectUsageLimit: (
		response: Response,
	) => Promise<"rate_limit" | "plan_ineligible" | null>;
}

export interface RotatingFetchResult {
	account: AccountRecord;
	response: Response;
}

/**
 * Select an account, refresh its token, and send the request — retrying on
 * another account when the backend returns a hard usage-limit error. Caps the
 * number of actual backend sends at config.maxFallbackAttempts. Refresh failures
 * skip to the next account without consuming a send. Throws NoUsableAccountError
 * only when nothing could ever be sent.
 */
export async function rotatingFetch(
	deps: RotatingFetchDeps,
): Promise<RotatingFetchResult> {
	const tried = new Set<string>();
	let last: RotatingFetchResult | null = null;
	let sends = 0;

	while (true) {
		let account: AccountRecord;
		try {
			account = deps.manager.selectAccount(tried);
		} catch {
			break; // no usable account left
		}

		const fresh = await deps.manager.ensureFreshToken(account);
		if (!fresh) {
			tried.add(account.id); // refresh/plan failure — try another, no send
			continue;
		}

		const response = await deps.doFetch(fresh);
		sends++;
		last = { account: fresh, response };

		if (response.ok) return last;

		const kind = await deps.inspectUsageLimit(response);
		if (kind === "rate_limit" || kind === "plan_ineligible") {
			if (kind === "rate_limit") deps.manager.markCooldownFromError(fresh.id);
			else deps.manager.markInvalid(fresh.id, "plan_ineligible");
			tried.add(fresh.id);
			if (sends >= deps.config.maxFallbackAttempts) break;
			continue;
		}

		// Non-usage error — surface as-is.
		return last;
	}

	if (last) return last;
	throw new NoUsableAccountError();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- rotating-fetch`
Expected: PASS (all 7 cases green).

- [ ] **Step 5: Commit**

```bash
git add lib/request/rotating-fetch.ts test/rotating-fetch.test.ts
git commit -m "feat: add account rotation orchestration loop"
```

---

## Task 13: Wire the manager into `index.ts` (loader + fetch)

**Files:**
- Modify: `index.ts`
- Test: `test/rotation-plugin.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `test/rotation-plugin.test.ts`. This drives the real plugin `loader` + `fetch` end-to-end with a mocked global `fetch`, a fake opencode client, and a temp pool file.

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore } from '../lib/accounts/store.js';
import * as storeModule from '../lib/accounts/store.js';
import * as authModule from '../lib/auth/auth.js';
import { OpenAIAuthPlugin } from '../index.js';
import type { AccountPool } from '../lib/types.js';

/** A JWT whose auth claim has the given account id + paid plan. */
function token(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64');
	const payload = Buffer.from(JSON.stringify({
		'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'pro' },
	})).toString('base64');
	return `${header}.${payload}.sig`;
}

/** Minimal SSE body Codex returns; convertSseToJson reads response.done. */
function sseBody(): string {
	return `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'r1' } })}\n\n`;
}

let dir: string;
let poolPath: string;
let pool: AccountPool;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'codex-plugin-'));
	poolPath = join(dir, 'accounts.json');
	pool = {
		version: 1,
		activeId: 'acc_1',
		accounts: [
			{ id: 'acc_1', priority: 1, access: token('acc_1'), refresh: 'r1', expires: Number.MAX_SAFE_INTEGER, status: 'healthy', invalidReason: null, statusAt: 0, cooldownUntil: null, usage: null },
			{ id: 'acc_2', priority: 2, access: token('acc_2'), refresh: 'r2', expires: Number.MAX_SAFE_INTEGER, status: 'healthy', invalidReason: null, statusAt: 0, cooldownUntil: null, usage: null },
		],
	};
	writeFileSync(poolPath, JSON.stringify(pool));
	// Point the plugin's store at our temp pool file.
	vi.spyOn(storeModule, 'createFileStore').mockImplementation(() => createFileStore(poolPath));
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

/** Build the plugin's fetch via loader, with a fake opencode client. */
async function buildFetch() {
	const auth = { type: 'oauth', access: token('acc_1'), refresh: 'r1', expires: Number.MAX_SAFE_INTEGER };
	const client: any = { auth: { set: vi.fn() }, tui: { showToast: vi.fn() } };
	const plugin = await OpenAIAuthPlugin({ client } as any);
	const provider = { options: {}, models: {} };
	const sdk = await plugin.auth!.loader!(async () => auth as any, provider);
	return { fetch: (sdk as any).fetch as (input: any, init?: any) => Promise<Response>, client };
}

function streamingInit() {
	return { method: 'POST', body: JSON.stringify({ model: 'gpt-5-codex', stream: true, input: [] }) };
}

describe('plugin rotation (integration)', () => {
	it('uses the active account and records usage on a normal turn', async () => {
		const seen: Record<string, string | null> = {};
		const g = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init: any) => {
			seen.account = new Headers(init.headers).get('chatgpt-account-id');
			return new Response(sseBody(), { status: 200, headers: { 'x-codex-primary-used-percent': '40', 'x-codex-primary-reset-after-seconds': '1000' } });
		});

		const { fetch } = await buildFetch();
		const res = await fetch('https://chatgpt.com/backend-api/responses', streamingInit());

		expect(res.status).toBe(200);
		expect(seen.account).toBe('acc_1');
		g.mockRestore();
	});

	it('switches to acc_2 on the next turn after acc_1 crosses the threshold', async () => {
		// Turn 1: acc_1 responds at 95% -> cooldown set.
		const g = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init: any) => {
			const id = new Headers(init.headers).get('chatgpt-account-id');
			const used = id === 'acc_1' ? '95' : '10';
			return new Response(sseBody(), { status: 200, headers: { 'x-codex-primary-used-percent': used, 'x-codex-primary-reset-after-seconds': '3600' } });
		});

		const { fetch } = await buildFetch();
		await fetch('https://chatgpt.com/backend-api/responses', streamingInit()); // turn 1 (acc_1)
		const accountsUsed: (string | null)[] = [];
		g.mockImplementation(async (_url, init: any) => {
			accountsUsed.push(new Headers(init.headers).get('chatgpt-account-id'));
			return new Response(sseBody(), { status: 200, headers: { 'x-codex-primary-used-percent': '10' } });
		});
		await fetch('https://chatgpt.com/backend-api/responses', streamingInit()); // turn 2

		expect(accountsUsed).toContain('acc_2'); // switched away from acc_1
		g.mockRestore();
	});

	it('falls back within one turn when acc_1 returns a hard usage limit', async () => {
		const accountsUsed: (string | null)[] = [];
		const g = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init: any) => {
			const id = new Headers(init.headers).get('chatgpt-account-id');
			accountsUsed.push(id);
			if (id === 'acc_1') {
				return new Response(JSON.stringify({ error: { code: 'usage_limit_reached' } }), { status: 429 });
			}
			return new Response(sseBody(), { status: 200, headers: { 'x-codex-primary-used-percent': '10' } });
		});

		const { fetch } = await buildFetch();
		const res = await fetch('https://chatgpt.com/backend-api/responses', streamingInit());

		expect(res.status).toBe(200);
		expect(accountsUsed).toEqual(['acc_1', 'acc_2']);
		g.mockRestore();
	});
});
```

> If `vi.spyOn(storeModule, 'createFileStore')` cannot be re-assigned (ESM export immutability under the test runner), the fallback is to set `process.env` / inject the path; but vitest transforms modules to allow spying on named exports, so this works with the project's existing setup (see how `test/fetch-helpers.test.ts` spies on `authModule.refreshAccessToken`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- rotation-plugin`
Expected: FAIL — `index.ts` still uses the single-account flow; e.g. the hard-limit fallback test sees only `['acc_1']` and a 429.

- [ ] **Step 3: Update `index.ts` imports**

Add these imports near the other `lib/...` imports in `index.ts`:

```ts
import { getCodexMode, getRotationConfig, loadPluginConfig } from "./lib/config.js";
import { createFileStore } from "./lib/accounts/store.js";
import { createAccountManager } from "./lib/accounts/manager.js";
import { NoUsableAccountError } from "./lib/accounts/errors.js";
import { rotatingFetch } from "./lib/request/rotating-fetch.js";
import { ROTATION_ERROR_MESSAGES } from "./lib/constants.js";
```

(Replace the existing `import { getCodexMode, loadPluginConfig } from "./lib/config.js";` line with the combined version above.)

Add `refreshAccessToken` to the existing `./lib/auth/auth.js` import block (it already imports `createAuthorizationFlow`, `decodeJWT`, `exchangeAuthorizationCode`, `parseAuthorizationInput`, `REDIRECT_URI` — add `refreshAccessToken` to that list). And add `inspectUsageLimitResponse` to the existing import from `./lib/request/fetch-helpers.js`.

Add `inspectUsageLimitResponse` to the existing `fetch-helpers` import list:

```ts
import {
	createCodexHeaders,
	extractRequestUrl,
	handleErrorResponse,
	handleSuccessResponse,
	inspectUsageLimitResponse,
	rewriteUrlForCodex,
	transformRequestForCodex,
} from "./lib/request/fetch-helpers.js";
```

(Drop `refreshAndUpdateToken` and `shouldRefreshToken` from that import — they are replaced by the manager's per-account refresh. `refreshAccessToken` is now imported from `./lib/auth/auth.js` for the manager.)

- [ ] **Step 4: Build the manager in the loader**

In `index.ts`, inside `loader`, after the `const codexMode = getCodexMode(pluginConfig);` line, add:

```ts
				// Multi-account rotation setup
				const rotationConfig = getRotationConfig(pluginConfig);
				const accountStore = createFileStore();
				const accountManager = createAccountManager({
					store: accountStore,
					config: rotationConfig,
					refresh: refreshAccessToken,
					client,
				});
				// Seed the pool from the current oauth slot for existing single-account users.
				accountManager.seedFromAuth(auth);
```

- [ ] **Step 5: Replace the fetch body with the rotation flow**

Replace the entire `async fetch(input, init) { ... }` implementation (Steps 1–7 in the current code) with:

```ts
					async fetch(
						input: Request | string | URL,
						init?: RequestInit,
					): Promise<Response> {
						// Extract and rewrite URL for Codex backend
						const originalUrl = extractRequestUrl(input);
						const url = rewriteUrlForCodex(originalUrl);

						// Capture original stream value before transformation
						const originalBody = init?.body ? JSON.parse(init.body as string) : {};
						const isStreaming = originalBody.stream === true;

						// Transform request body with model-specific Codex instructions
						const transformation = await transformRequestForCodex(
							init,
							url,
							userConfig,
							codexMode,
						);
						const requestInit = transformation?.updatedInit ?? init;

						// Build the per-account send: headers carry the selected account's
						// token + id; applyActive mirrors it into the opencode slot.
						const doFetch = async (account: {
							id: string;
							access: string;
							refresh: string;
							expires: number;
						}) => {
							await accountManager.applyActive(account as any);
							const headers = createCodexHeaders(
								requestInit,
								account.id,
								account.access,
								{
									model: transformation?.body.model,
									promptCacheKey: (transformation?.body as any)?.prompt_cache_key,
								},
							);
							return fetch(url, { ...requestInit, headers });
						};

						// Select an account, refresh, send, and fall back on hard limits.
						let account: { id: string };
						let response: Response;
						try {
							const result = await rotatingFetch({
								manager: accountManager,
								config: rotationConfig,
								doFetch: doFetch as any,
								inspectUsageLimit: inspectUsageLimitResponse,
							});
							account = result.account;
							response = result.response;
						} catch (e) {
							if (e instanceof NoUsableAccountError) {
								throw new Error(ROTATION_ERROR_MESSAGES.NO_USABLE_ACCOUNTS);
							}
							throw e;
						}

						// Log response
						logRequest(LOG_STAGES.RESPONSE, {
							status: response.status,
							ok: response.ok,
							statusText: response.statusText,
							headers: Object.fromEntries(response.headers.entries()),
						});

						if (!response.ok) {
							return await handleErrorResponse(response);
						}

						// Record usage so the next turn can switch if over threshold.
						accountManager.recordResponseUsage(account.id, response.headers);
						return await handleSuccessResponse(response, isStreaming);
					},
```

- [ ] **Step 6: Run the integration test + typecheck**

Run: `npm test -- rotation-plugin && npm run typecheck`
Expected: PASS — all three integration scenarios green; no type errors.

> If typecheck complains about `doFetch` parameter typing, import `AccountRecord` from `./lib/types.js` and type the `doFetch` parameter as `AccountRecord` instead of the inline shape + `as any`. Prefer the typed version if it compiles cleanly.

- [ ] **Step 7: Commit**

```bash
git add index.ts test/rotation-plugin.test.ts
git commit -m "feat: rotate accounts in the request path"
```

---

## Task 14: Capture logins in the OAuth callbacks

**Files:**
- Modify: `index.ts`
- Test: `test/rotation-plugin.test.ts`

**Problem:** `captureLogin` must run when a user completes OAuth, but the OAuth `authorize` methods live in `methods:` and don't have access to the `accountManager` built inside `loader` (the loader may not have run, and its manager is closure-local). Build a second manager instance (same file-backed store) at plugin scope and call `captureLogin` from both callbacks.

- [ ] **Step 1: Write the failing test**

Append to `test/rotation-plugin.test.ts`:

```ts
describe('capture-on-login', () => {
	it('adds a completed OAuth login to the pool', async () => {
		// Start with an empty pool for this test.
		writeFileSync(poolPath, JSON.stringify({ version: 1, activeId: null, accounts: [] }));

		vi.spyOn(authModule, 'exchangeAuthorizationCode').mockResolvedValue({
			type: 'success', access: token('acc_new'), refresh: 'rnew', expires: 123,
		} as any);

		const client: any = { auth: { set: vi.fn() }, tui: { showToast: vi.fn() } };
		const plugin = await OpenAIAuthPlugin({ client } as any);
		const methods = plugin.auth!.methods as any[];
		const manual = methods.find((m) => m.type === 'oauth' && typeof m.authorize === 'function' && m.label?.includes('Manual'));
		const flow = await manual.authorize();
		const result = await flow.callback('https://localhost/cb?code=abc&state=xyz');

		expect(result.type).toBe('success');
		const saved = JSON.parse(readFileSync(poolPath, 'utf-8'));
		expect(saved.accounts.map((a: any) => a.id)).toContain('acc_new');
	});
});
```

> Add `readFileSync` to the existing `node:fs` import at the top of
> `test/rotation-plugin.test.ts` (it currently imports
> `{ mkdtempSync, rmSync, writeFileSync }`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- rotation-plugin`
Expected: FAIL — the login is not captured into the pool (`acc_new` absent).

- [ ] **Step 3: Build a plugin-scope manager and capture in callbacks**

In `index.ts`, at the top of the `OpenAIAuthPlugin` function body (just after the `buildManualOAuthFlow` definition or before `return {`), create a capture helper backed by the same store:

```ts
	// Plugin-scope manager for capturing logins (the loader builds its own for requests).
	const loginCaptureManager = createAccountManager({
		store: createFileStore(),
		config: getRotationConfig(loadPluginConfig()),
		refresh: refreshAccessToken,
		client,
	});
	const captureTokens = (tokens: {
		type: string;
		access?: string;
		refresh?: string;
		expires?: number;
	}) => {
		if (tokens.type === "success" && tokens.access && tokens.refresh) {
			loginCaptureManager.captureLogin({
				access: tokens.access,
				refresh: tokens.refresh,
				expires: tokens.expires ?? 0,
			});
		}
	};
```

Update `buildManualOAuthFlow`'s callback to capture before returning. Replace its `callback` body's success return with a capture call:

```ts
		callback: async (input: string) => {
			const parsed = parseAuthorizationInput(input);
			if (!parsed.code) {
				return { type: "failed" as const };
			}
			const tokens = await exchangeAuthorizationCode(
				parsed.code,
				pkce.verifier,
				REDIRECT_URI,
			);
			if (tokens?.type === "success") {
				captureTokens(tokens);
				return tokens;
			}
			return { type: "failed" as const };
		},
```

In the auto-flow `authorize` (the one using `serverInfo.waitForCode`), update its `callback` success path the same way:

```ts
							const tokens = await exchangeAuthorizationCode(
								result.code,
								pkce.verifier,
								REDIRECT_URI,
							);

							if (tokens?.type === "success") {
								captureTokens(tokens);
								return tokens;
							}
							return { type: "failed" as const };
```

(Replace the existing `return tokens?.type === "success" ? tokens : { type: "failed" as const };` lines in both callbacks with the capture-aware version above.)

- [ ] **Step 4: Run the test + full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — capture-on-login test green; all prior tests still green.

- [ ] **Step 5: Commit**

```bash
git add index.ts test/rotation-plugin.test.ts
git commit -m "feat: capture ChatGPT accounts on OAuth login"
```

---

## Task 15: Documentation

**Files:**
- Modify: `docs/configuration.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Document rotation config in `docs/configuration.md`**

Add a new section to `docs/configuration.md` (match the file's existing heading style):

```markdown
## Multi-account rotation

Configure multiple ChatGPT accounts and have the plugin switch between them
automatically as usage limits approach, without resetting your session.

### Adding accounts

Run the OAuth login once per account:

```bash
opencode auth login    # choose "ChatGPT Plus/Pro (Codex Subscription)" and sign in
```

Each completed login is added to the pool at
`~/.opencode/openai-codex-accounts.json` (keyed by ChatGPT account id, so
re-logging an account updates it in place). Rotation engages automatically once
two or more accounts are present.

### Settings

Add a `rotation` block to `~/.opencode/openai-codex-auth-config.json`:

```jsonc
{
  "rotation": {
    "enabled": true,            // set false to force single-account behavior
    "thresholdPercent": 90,     // switch when the 5h window reaches this percent
    "includeWeeklyWindow": true,// also switch when the weekly window is exhausted
    "maxFallbackAttempts": 3    // accounts tried within one turn on a hard limit
  }
}
```

### Behavior

- When the active account's 5h usage reaches `thresholdPercent`, the next turn is
  served by another account (by ascending `priority`).
- If a request hits a hard usage limit mid-turn, the plugin retries the same
  request on another account so the turn still completes.
- An account whose subscription has lapsed to free, or whose login was revoked,
  is disabled and skipped until you re-login (re-subscribe first for plan lapses).
- Switches surface as a TUI toast and are written to the plugin log.

Account priority follows login order; edit `priority` (and optional `label`) in
the pool file to change preference.
```

- [ ] **Step 2: Add a short mention + link in `README.md`**

Add a bullet under the features/usage section of `README.md` (match existing style):

```markdown
- **Multi-account rotation** — configure several ChatGPT accounts and rotate
  between them automatically as the 5h usage limit approaches, without losing
  your session. See [Configuration → Multi-account rotation](docs/configuration.md#multi-account-rotation).
```

- [ ] **Step 3: Add a CHANGELOG entry**

Add to the top of `CHANGELOG.md` (match the existing entry format; use an Unreleased/next-version heading consistent with the file):

```markdown
### Added
- Multi-account rotation: configure multiple ChatGPT accounts and switch between
  them automatically based on the 5h usage window, with hard-limit fallback and
  detection of revoked/free-plan accounts.
```

- [ ] **Step 4: Verify docs build is not broken (links/markdown)**

Run: `npm test && npm run typecheck`
Expected: PASS (no code changed; confirms nothing regressed).

- [ ] **Step 5: Commit**

```bash
git add docs/configuration.md README.md CHANGELOG.md
git commit -m "docs: document multi-account rotation"
```

---

## Task 16: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: PASS — all suites, including `accounts-token`, `accounts-usage`, `accounts-store`, `accounts-manager`, `rotating-fetch`, `rotation-plugin`, and all pre-existing tests.

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: PASS — clean compile, `dist/` produced.

- [ ] **Step 3: Confirm no stray single-account assumptions remain**

Run: `grep -rn "refreshAndUpdateToken\|shouldRefreshToken" index.ts`
Expected: no matches in `index.ts` (the per-account manager replaced them). The functions may still exist in `lib/request/fetch-helpers.ts` and its tests — that is fine; they are simply no longer used by `index.ts`.

- [ ] **Step 4: Final commit (if any cleanup was needed)**

```bash
git add -A
git commit -m "chore: finalize multi-account rotation" || echo "nothing to commit"
```

---

## Implementation Notes

- **Why `rotatingFetch` is separate from the manager:** the loop is pure control
  flow over a small manager port and a `doFetch` callback, so it is unit-testable
  without mocking global `fetch` or constructing the whole plugin. The manager
  owns state; the loop owns retry orchestration.
- **Context preservation:** nothing in this plan touches opencode's session/message
  state. opencode resends the full conversation `input` each turn; rotation only
  changes which account's token + `chatgpt-account-id` are attached. Switches
  happen at the turn boundary or as an in-request retry, never mid-stream.
- **Prompt caching:** switching accounts causes a cache miss on the new account
  (the `prompt_cache_key` is unchanged but the cache is per-account). This is a
  one-turn latency cost, not a correctness issue, and is out of scope to optimize.
- **Toast API shape:** `client.tui?.showToast?.(...)` is called defensively inside
  try/catch; verify the exact call shape against the running opencode at manual
  test time. A failed toast never affects request handling.
```
