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

	it('returns the last failing response when the pool is exhausted before the cap', async () => {
		const manager = fakeManager(['a']); // single account, max attempts not reached
		const doFetch = vi.fn(async () => new Response('limit', { status: 429 }));
		const inspect = vi.fn(async () => 'rate_limit' as const);

		const { account, response } = await rotatingFetch({ manager, config: CONFIG, doFetch, inspectUsageLimit: inspect });

		expect(response.status).toBe(429);
		expect(account.id).toBe('a');
		expect(doFetch).toHaveBeenCalledTimes(1);
		expect(manager.markCooldownFromError).toHaveBeenCalledWith('a');
	});

	it('propagates a non-NoUsableAccountError thrown by selectAccount', async () => {
		const manager = fakeManager(['a']);
		manager.selectAccount = vi.fn(() => { throw new Error('boom'); });
		const doFetch = vi.fn();
		const inspect = vi.fn();
		await expect(
			rotatingFetch({ manager, config: CONFIG, doFetch, inspectUsageLimit: inspect }),
		).rejects.toThrow('boom');
		expect(doFetch).not.toHaveBeenCalled();
	});
});
