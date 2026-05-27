import { USAGE_HEADERS, USAGE_LIMIT_CODES } from "../constants.js";
import type { RotationConfig, UsageSnapshot, WindowUsage } from "../types.js";

function parseWindow(
	headers: Headers,
	usedKey: string,
	windowKey: string,
	resetKey: string,
	now: number,
): WindowUsage | undefined {
	const usedRaw = headers.get(usedKey);
	if (usedRaw === null) return undefined;
	const usedPercent = Number.parseFloat(usedRaw);
	if (Number.isNaN(usedPercent)) return undefined;
	const windowMinutes = Number.parseInt(headers.get(windowKey) ?? "0", 10) || 0;
	const resetSeconds = Number.parseInt(headers.get(resetKey) ?? "0", 10) || 0;
	return { usedPercent, windowMinutes, resetsAt: now + resetSeconds * 1000 };
}

/**
 * Parse Codex rate-limit headers into a usage snapshot.
 * Returns null when no usage headers are present (request still proceeds).
 */
export function parseUsageHeaders(
	headers: Headers,
	now: number = Date.now(),
): UsageSnapshot | null {
	const primary = parseWindow(
		headers,
		USAGE_HEADERS.PRIMARY_USED_PERCENT,
		USAGE_HEADERS.PRIMARY_WINDOW_MINUTES,
		USAGE_HEADERS.PRIMARY_RESET_SECONDS,
		now,
	);
	const secondary = parseWindow(
		headers,
		USAGE_HEADERS.SECONDARY_USED_PERCENT,
		USAGE_HEADERS.SECONDARY_WINDOW_MINUTES,
		USAGE_HEADERS.SECONDARY_RESET_SECONDS,
		now,
	);
	if (!primary && !secondary) return null;
	return { primary, secondary, updatedAt: now };
}

/**
 * If any in-scope window is at/above threshold, return the soonest reset time
 * among those windows; otherwise null. The 5h primary always counts; the weekly
 * secondary counts only when includeWeeklyWindow is true.
 */
export function overThresholdResetsAt(
	snapshot: UsageSnapshot | null | undefined,
	config: RotationConfig,
): number | null {
	if (!snapshot) return null;
	const resets: number[] = [];
	if (snapshot.primary && snapshot.primary.usedPercent >= config.thresholdPercent) {
		resets.push(snapshot.primary.resetsAt);
	}
	if (
		config.includeWeeklyWindow &&
		snapshot.secondary &&
		snapshot.secondary.usedPercent >= config.thresholdPercent
	) {
		resets.push(snapshot.secondary.resetsAt);
	}
	return resets.length ? Math.min(...resets) : null;
}

/**
 * Classify a usage-limit error by its code/body text.
 * plan_ineligible is checked first so usage_not_included is not mistaken for a
 * recoverable rate limit.
 */
export function classifyUsageLimitError(
	code: string,
	text: string,
): "rate_limit" | "plan_ineligible" | null {
	const haystack = `${code} ${text}`.toLowerCase();
	if (USAGE_LIMIT_CODES.PLAN_INELIGIBLE.some((c) => haystack.includes(c))) {
		return "plan_ineligible";
	}
	if (
		USAGE_LIMIT_CODES.RATE_LIMIT.some((c) => haystack.includes(c)) ||
		haystack.includes("usage limit")
	) {
		return "rate_limit";
	}
	return null;
}
