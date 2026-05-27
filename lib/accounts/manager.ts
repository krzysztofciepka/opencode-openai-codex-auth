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
