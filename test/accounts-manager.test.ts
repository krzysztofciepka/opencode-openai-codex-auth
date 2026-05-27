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
