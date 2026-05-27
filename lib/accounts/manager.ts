import type { OpencodeClient } from "@opencode-ai/sdk";
import { logDebug, logWarn } from "../logger.js";
import type {
	AccountRecord,
	InvalidReason,
	RotationConfig,
	TokenResult,
} from "../types.js";
import { DEFAULT_COOLDOWN_MS } from "../constants.js";
import type { AccountStore } from "./store.js";
import { NoUsableAccountError } from "./errors.js";
import { overThresholdResetsAt, parseUsageHeaders } from "./usage.js";
import { classifyPlan, getAccountIdFromToken } from "./token.js";

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
	let lastMirrored: { id: string; access: string } | null = null;

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
	};

	return manager;
}
