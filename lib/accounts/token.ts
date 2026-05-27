import { decodeJWT } from "../auth/auth.js";
import { JWT_CLAIM_PATH, PAID_PLAN_TYPES } from "../constants.js";
import type { PlanClass } from "../types.js";

/**
 * Classify a ChatGPT plan from an access/id token's auth claim.
 * A MISSING or unrecognized plan is "unknown" (never "free"), to avoid
 * wrongly disabling paid accounts affected by OpenAI's missing-claim bug.
 */
export function classifyPlan(token: string): PlanClass {
	const planType = decodeJWT(token)?.[JWT_CLAIM_PATH]?.chatgpt_plan_type;
	if (typeof planType !== "string" || planType.length === 0) return "unknown";
	const normalized = planType.toLowerCase();
	if (normalized === "free") return "free";
	if ((PAID_PLAN_TYPES as readonly string[]).includes(normalized)) return "paid";
	return "unknown";
}

/** Extract the chatgpt_account_id from a token, or undefined. */
export function getAccountIdFromToken(token: string): string | undefined {
	return decodeJWT(token)?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
}
