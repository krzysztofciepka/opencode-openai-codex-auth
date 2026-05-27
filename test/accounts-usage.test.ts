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
