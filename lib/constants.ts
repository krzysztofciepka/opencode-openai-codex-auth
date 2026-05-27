/**
 * Constants used throughout the plugin
 * Centralized for easy maintenance and configuration
 */

/** Plugin identifier for logging and error messages */
export const PLUGIN_NAME = "openai-codex-plugin";

/** Base URL for ChatGPT backend API */
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

/** Dummy API key used for OpenAI SDK (actual auth via OAuth) */
export const DUMMY_API_KEY = "chatgpt-oauth";

/** Provider ID for opencode configuration */
export const PROVIDER_ID = "openai";

/** HTTP Status Codes */
export const HTTP_STATUS = {
	OK: 200,
	UNAUTHORIZED: 401,
	NOT_FOUND: 404,
	TOO_MANY_REQUESTS: 429,
} as const;

/** OpenAI-specific headers */
export const OPENAI_HEADERS = {
	BETA: "OpenAI-Beta",
	ACCOUNT_ID: "chatgpt-account-id",
	ORIGINATOR: "originator",
	SESSION_ID: "session_id",
	CONVERSATION_ID: "conversation_id",
} as const;

/** OpenAI-specific header values */
export const OPENAI_HEADER_VALUES = {
	BETA_RESPONSES: "responses=experimental",
	ORIGINATOR_CODEX: "codex_cli_rs",
} as const;

/** URL path segments */
export const URL_PATHS = {
	RESPONSES: "/responses",
	CODEX_RESPONSES: "/codex/responses",
} as const;

/** JWT claim path for ChatGPT account ID */
export const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;

/** Error messages */
export const ERROR_MESSAGES = {
	NO_ACCOUNT_ID: "Failed to extract accountId from token",
	TOKEN_REFRESH_FAILED: "Failed to refresh token, authentication required",
	REQUEST_PARSE_ERROR: "Error parsing request",
	NO_USABLE_ACCOUNTS:
		"All ChatGPT accounts are unavailable (invalid or exhausted). Run `opencode auth login` to add or re-authorize an account.",
} as const;

/** Log stages for request logging */
export const LOG_STAGES = {
	BEFORE_TRANSFORM: "before-transform",
	AFTER_TRANSFORM: "after-transform",
	RESPONSE: "response",
	ERROR_RESPONSE: "error-response",
} as const;

/** Platform-specific browser opener commands */
export const PLATFORM_OPENERS = {
	darwin: "open",
	win32: "start",
	linux: "xdg-open",
} as const;

/** OAuth authorization labels */
export const AUTH_LABELS = {
	OAUTH: "ChatGPT Plus/Pro (Codex Subscription)",
	OAUTH_MANUAL: "ChatGPT Plus/Pro (Manual URL Paste)",
	API_KEY: "Manually enter API Key",
	INSTRUCTIONS:
		"A browser window should open. If it doesn't, copy the URL and open it manually.",
	INSTRUCTIONS_MANUAL:
		"After logging in, copy the full redirect URL and paste it here.",
} as const;

/** Codex rate-limit response headers (primary = 5h window, secondary = weekly) */
export const USAGE_HEADERS = {
	PRIMARY_USED_PERCENT: "x-codex-primary-used-percent",
	PRIMARY_WINDOW_MINUTES: "x-codex-primary-window-minutes",
	PRIMARY_RESET_SECONDS: "x-codex-primary-reset-after-seconds",
	SECONDARY_USED_PERCENT: "x-codex-secondary-used-percent",
	SECONDARY_WINDOW_MINUTES: "x-codex-secondary-window-minutes",
	SECONDARY_RESET_SECONDS: "x-codex-secondary-reset-after-seconds",
} as const;

/** ChatGPT plan types that include Codex access */
export const PAID_PLAN_TYPES = [
	"plus",
	"pro",
	"team",
	"business",
	"enterprise",
] as const;

/** Substrings identifying usage-limit error responses, by kind */
export const USAGE_LIMIT_CODES = {
	/** Temporary — account is rate-limited and will recover at reset */
	RATE_LIMIT: ["usage_limit_reached", "rate_limit_exceeded"],
	/** Permanent until re-subscribe — plan does not include Codex */
	PLAN_INELIGIBLE: ["usage_not_included"],
} as const;

/** Default rotation settings (merged with user config) */
export const DEFAULT_ROTATION = {
	enabled: true,
	thresholdPercent: 90,
	includeWeeklyWindow: true,
	maxFallbackAttempts: 3,
} as const;

/** Fallback cooldown when a hard limit gives no reset hint (15 min) */
export const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
