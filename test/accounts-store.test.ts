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
