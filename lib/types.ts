import type { Auth, Provider, Model } from "@opencode-ai/sdk";

/**
 * Plugin configuration from ~/.opencode/openai-codex-auth-config.json
 */
export interface PluginConfig {
	/**
	 * Enable CODEX_MODE (Codex-OpenCode bridge prompt instead of tool remap)
	 * @default true
	 */
	codexMode?: boolean;

	/** Multi-account rotation settings (partial; merged with defaults) */
	rotation?: Partial<RotationConfig>;
}

/**
 * User configuration structure from opencode.json
 */
export interface UserConfig {
	global: ConfigOptions;
	models: {
		[modelName: string]: {
			options?: ConfigOptions;
			variants?: Record<string, (ConfigOptions & { disabled?: boolean }) | undefined>;
			[key: string]: unknown;
		};
	};
}

/**
 * Configuration options for reasoning and text settings
 */
export interface ConfigOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on";
	textVerbosity?: "low" | "medium" | "high";
	include?: string[];
}

/**
 * Reasoning configuration for requests
 */
export interface ReasoningConfig {
	effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	summary: "auto" | "concise" | "detailed" | "off" | "on";
}

/**
 * OAuth server information
 */
export interface OAuthServerInfo {
	port: number;
	ready: boolean;
	close: () => void;
	waitForCode: (state: string) => Promise<{ code: string } | null>;
}

/**
 * PKCE challenge and verifier
 */
export interface PKCEPair {
	challenge: string;
	verifier: string;
}

/**
 * Authorization flow result
 */
export interface AuthorizationFlow {
	pkce: PKCEPair;
	state: string;
	url: string;
}

/**
 * Token exchange success result
 */
export interface TokenSuccess {
	type: "success";
	access: string;
	refresh: string;
	expires: number;
}

/**
 * Token exchange failure result
 */
export interface TokenFailure {
	type: "failed";
}

/**
 * Token exchange result
 */
export type TokenResult = TokenSuccess | TokenFailure;

/**
 * Parsed authorization input
 */
export interface ParsedAuthInput {
	code?: string;
	state?: string;
}

/**
 * JWT payload with ChatGPT account info
 */
export interface JWTPayload {
	"https://api.openai.com/auth"?: {
		chatgpt_account_id?: string;
		chatgpt_user_id?: string;
		chatgpt_plan_type?: string;
	};
	[key: string]: unknown;
}

/**
 * Message input item
 */
export interface InputItem {
	id?: string;
	type: string;
	role: string;
	content?: unknown;
	[key: string]: unknown;
}

/**
 * Request body structure
 */
export interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	input?: InputItem[];
	tools?: unknown;
	reasoning?: Partial<ReasoningConfig>;
	text?: {
		verbosity?: "low" | "medium" | "high";
	};
	include?: string[];
	providerOptions?: {
		openai?: Partial<ConfigOptions> & { store?: boolean; include?: string[] };
		[key: string]: unknown;
	};
	/** Stable key to enable prompt-token caching on Codex backend */
	prompt_cache_key?: string;
	max_output_tokens?: number;
	max_completion_tokens?: number;
	[key: string]: unknown;
}

/**
 * SSE event data structure
 */
export interface SSEEventData {
	type: string;
	response?: unknown;
	[key: string]: unknown;
}

/**
 * Cache metadata for Codex instructions
 */
export interface CacheMetadata {
	etag: string | null;
	tag: string;
	lastChecked: number;
	url: string;
}

/**
 * GitHub release data
 */
export interface GitHubRelease {
	tag_name: string;
	[key: string]: unknown;
}

/** Classification of a ChatGPT plan from the JWT `chatgpt_plan_type` claim */
export type PlanClass = "paid" | "free" | "unknown";

/** Resolved multi-account rotation settings */
export interface RotationConfig {
	/** When false, behaves as single-account (no rotation). Auto-on with 2+ accounts. */
	enabled: boolean;
	/** 5h primary-window used-percent at which to switch accounts */
	thresholdPercent: number;
	/** Also treat an account unavailable when its weekly window is exhausted */
	includeWeeklyWindow: boolean;
	/** Max backend sends within one request when falling back on a hard limit */
	maxFallbackAttempts: number;
}

/** Usage for a single rate-limit window (5h primary or weekly secondary) */
export interface WindowUsage {
	usedPercent: number;
	windowMinutes: number;
	/** Absolute epoch-ms time when this window resets */
	resetsAt: number;
}

/** Snapshot of both rate-limit windows parsed from a response */
export interface UsageSnapshot {
	primary?: WindowUsage;
	secondary?: WindowUsage;
	/** epoch-ms when this snapshot was recorded */
	updatedAt: number;
}

/** Lifecycle status of a pooled account */
export type AccountStatus = "healthy" | "cooldown" | "invalid";

/** Reason an account is `invalid` */
export type InvalidReason = "auth_failed" | "plan_ineligible";

/** One ChatGPT account in the rotation pool */
export interface AccountRecord {
	/** chatgpt_account_id — stable key, dedupes on re-login */
	id: string;
	label?: string;
	/** selection order; lower wins */
	priority: number;
	/** OAuth access token */
	access: string;
	/** OAuth refresh token */
	refresh: string;
	/** epoch-ms expiry of the access token */
	expires: number;
	status: AccountStatus;
	invalidReason?: InvalidReason | null;
	/** epoch-ms when status last changed */
	statusAt: number;
	/** epoch-ms until which the account is rate-limited (cooldown) */
	cooldownUntil?: number | null;
	usage?: UsageSnapshot | null;
}

/** Persisted account pool file shape */
export interface AccountPool {
	version: 1;
	activeId?: string | null;
	accounts: AccountRecord[];
}

// Re-export SDK types for convenience
export type { Auth, Provider, Model };
