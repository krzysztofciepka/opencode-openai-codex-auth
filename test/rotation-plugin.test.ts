import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as storeModule from '../lib/accounts/store.js';
import * as authModule from '../lib/auth/auth.js';
import * as codexPrompts from '../lib/prompts/codex.js';
import { OpenAIAuthPlugin } from '../index.js';
import type { AccountPool } from '../lib/types.js';

// Capture the REAL createFileStore BEFORE any spying, to avoid the spy recursing into itself.
const realCreateFileStore = storeModule.createFileStore;

/** A JWT whose auth claim has the given account id + paid plan. */
function token(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64');
	const payload = Buffer.from(JSON.stringify({
		'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'pro' },
	})).toString('base64');
	return `${header}.${payload}.sig`;
}

/** Minimal SSE body Codex returns; convertSseToJson reads response.completed. */
function sseBody(): string {
	return `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'r1' } })}\n\n`;
}

let dir: string;
let poolPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'codex-plugin-'));
	poolPath = join(dir, 'accounts.json');
	const pool: AccountPool = {
		version: 1,
		activeId: 'acc_1',
		accounts: [
			{ id: 'acc_1', priority: 1, access: token('acc_1'), refresh: 'r1', expires: Number.MAX_SAFE_INTEGER, status: 'healthy', invalidReason: null, statusAt: 0, cooldownUntil: null, usage: null },
			{ id: 'acc_2', priority: 2, access: token('acc_2'), refresh: 'r2', expires: Number.MAX_SAFE_INTEGER, status: 'healthy', invalidReason: null, statusAt: 0, cooldownUntil: null, usage: null },
		],
	};
	writeFileSync(poolPath, JSON.stringify(pool));
	// Point the plugin's store at our temp pool file (call the captured real impl, NOT the spied binding).
	vi.spyOn(storeModule, 'createFileStore').mockImplementation(() => realCreateFileStore(poolPath));
	// Avoid the real GitHub instructions fetch so global.fetch only sees Codex backend calls.
	vi.spyOn(codexPrompts, 'getCodexInstructions').mockResolvedValue('test-instructions');
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
		let seenAccount: string | null = null;
		const g = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init: any) => {
			seenAccount = new Headers(init.headers).get('chatgpt-account-id');
			return new Response(sseBody(), { status: 200, headers: { 'x-codex-primary-used-percent': '40', 'x-codex-primary-reset-after-seconds': '1000' } });
		});

		const { fetch } = await buildFetch();
		const res = await fetch('https://chatgpt.com/backend-api/responses', streamingInit());

		expect(res.status).toBe(200);
		expect(seenAccount).toBe('acc_1');
		g.mockRestore();
	});

	it('switches to acc_2 on the next turn after acc_1 crosses the threshold', async () => {
		const g = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init: any) => {
			const id = new Headers(init.headers).get('chatgpt-account-id');
			const used = id === 'acc_1' ? '95' : '10';
			return new Response(sseBody(), { status: 200, headers: { 'x-codex-primary-used-percent': used, 'x-codex-primary-reset-after-seconds': '3600' } });
		});

		const { fetch } = await buildFetch();
		await fetch('https://chatgpt.com/backend-api/responses', streamingInit()); // turn 1 (acc_1 → 95% → cooldown)
		const accountsUsed: (string | null)[] = [];
		g.mockImplementation(async (_url, init: any) => {
			accountsUsed.push(new Headers(init.headers).get('chatgpt-account-id'));
			return new Response(sseBody(), { status: 200, headers: { 'x-codex-primary-used-percent': '10' } });
		});
		await fetch('https://chatgpt.com/backend-api/responses', streamingInit()); // turn 2

		expect(accountsUsed).toContain('acc_2'); // switched away from acc_1
		g.mockRestore();
	});

	it('bypasses URL rewrite, OAuth headers, and rotation for non-Codex models', async () => {
		let seenUrl: string | null = null;
		let seenHeaders: Record<string, string> | null = null;
		const g = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init: any) => {
			seenUrl = typeof url === 'string' ? url : (url as URL).toString();
			seenHeaders = Object.fromEntries(new Headers(init.headers).entries());
			return new Response(JSON.stringify({ id: 'r1' }), { status: 200 });
		});

		const { fetch, client } = await buildFetch();
		const init = {
			method: 'POST',
			headers: { authorization: 'Bearer sk-blackbox', 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'minimax-m2.5', stream: true, input: [] }),
		};
		const res = await fetch('https://chatgpt.com/backend-api/responses', init);

		expect(res.status).toBe(200);
		expect(seenUrl).toBe('https://chatgpt.com/backend-api/responses'); // not rewritten to /codex/responses
		expect(seenHeaders!['chatgpt-account-id']).toBeUndefined();
		expect(seenHeaders!['authorization']).toBe('Bearer sk-blackbox'); // not replaced with OAuth bearer
		expect(client.auth.set).not.toHaveBeenCalled(); // no auth-slot mirroring
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
