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
		} catch (err) {
			if (!(err instanceof NoUsableAccountError)) throw err;
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
