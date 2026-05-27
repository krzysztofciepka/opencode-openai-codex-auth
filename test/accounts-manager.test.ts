import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAccountManager } from '../lib/accounts/manager.js';
import { NoUsableAccountError } from '../lib/accounts/errors.js';
import type { AccountPool, AccountRecord, RotationConfig, AccountStatus } from '../lib/types.js';
import * as tokenModule from '../lib/accounts/token.js';

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

	it('resets a previously-invalid account to healthy on successful refresh', async () => {
		const pool: AccountPool = { version: 1, activeId: 'a', accounts: [
			acct('a', { expires: 0, status: 'invalid', invalidReason: 'auth_failed' }),
		] };
		const { manager, store, refresh } = makeManager(pool, 1000);
		refresh.mockResolvedValue({ type: 'success', access: 'new-a', refresh: 'new-r', expires: 999999 });
		vi.spyOn(tokenModule, 'classifyPlan').mockReturnValue('paid');

		const result = await manager.ensureFreshToken(pool.accounts[0]);

		expect(result?.status).toBe('healthy');
		expect(result?.invalidReason).toBeNull();
		expect(store._current().accounts[0].status).toBe('healthy');
		expect(store._current().accounts[0].invalidReason).toBeNull();
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
