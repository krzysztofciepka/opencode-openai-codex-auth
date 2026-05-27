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
