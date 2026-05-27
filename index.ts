/**
 * OpenAI ChatGPT (Codex) OAuth Authentication Plugin for opencode
 *
 * COMPLIANCE NOTICE:
 * This plugin uses OpenAI's official OAuth authentication flow (the same method
 * used by OpenAI's official Codex CLI at https://github.com/openai/codex).
 *
 * INTENDED USE: Personal development and coding assistance with your own
 * ChatGPT Plus/Pro subscription.
 *
 * NOT INTENDED FOR: Commercial resale, multi-user services, high-volume
 * automated extraction, or any use that violates OpenAI's Terms of Service.
 *
 * Users are responsible for ensuring their usage complies with:
 * - OpenAI Terms of Use: https://openai.com/policies/terms-of-use/
 * - OpenAI Usage Policies: https://openai.com/policies/usage-policies/
 *
 * For production applications, use the OpenAI Platform API: https://platform.openai.com/
 *
 * @license MIT with Usage Disclaimer (see LICENSE file)
 * @author numman-ali
 * @repository https://github.com/numman-ali/opencode-openai-codex-auth
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk";
import {
	createAuthorizationFlow,
	decodeJWT,
	exchangeAuthorizationCode,
	parseAuthorizationInput,
	refreshAccessToken,
	REDIRECT_URI,
} from "./lib/auth/auth.js";
import { openBrowserUrl } from "./lib/auth/browser.js";
import { startLocalOAuthServer } from "./lib/auth/server.js";
import { getCodexMode, getRotationConfig, loadPluginConfig } from "./lib/config.js";
import {
	AUTH_LABELS,
	CODEX_BASE_URL,
	DUMMY_API_KEY,
	ERROR_MESSAGES,
	JWT_CLAIM_PATH,
	LOG_STAGES,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
	PLUGIN_NAME,
	PROVIDER_ID,
} from "./lib/constants.js";
import { logRequest, logDebug } from "./lib/logger.js";
import {
	createCodexHeaders,
	extractRequestUrl,
	handleErrorResponse,
	handleSuccessResponse,
	inspectUsageLimitResponse,
	rewriteUrlForCodex,
	transformRequestForCodex,
} from "./lib/request/fetch-helpers.js";
import { createFileStore } from "./lib/accounts/store.js";
import { createAccountManager } from "./lib/accounts/manager.js";
import { NoUsableAccountError } from "./lib/accounts/errors.js";
import { rotatingFetch } from "./lib/request/rotating-fetch.js";
import type { AccountRecord, UserConfig } from "./lib/types.js";

/**
 * OpenAI Codex OAuth authentication plugin for opencode
 *
 * This plugin enables opencode to use OpenAI's Codex backend via ChatGPT Plus/Pro
 * OAuth authentication, allowing users to leverage their ChatGPT subscription
 * instead of OpenAI Platform API credits.
 *
 * @example
 * ```json
 * {
 *   "plugin": ["opencode-openai-codex-auth"],
 *   "model": "openai/gpt-5-codex"
 * }
 * ```
 */
export const OpenAIAuthPlugin: Plugin = async ({ client }: PluginInput) => {
	const buildManualOAuthFlow = (pkce: { verifier: string }, url: string) => ({
		url,
		method: "code" as const,
		instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL,
		callback: async (input: string) => {
			const parsed = parseAuthorizationInput(input);
			if (!parsed.code) {
				return { type: "failed" as const };
			}
			const tokens = await exchangeAuthorizationCode(
				parsed.code,
				pkce.verifier,
				REDIRECT_URI,
			);
			if (tokens?.type === "success") {
				captureTokens(tokens);
				return tokens;
			}
			return { type: "failed" as const };
		},
	});
	// Plugin-scope manager for capturing logins (the loader builds its own for requests).
	const loginCaptureManager = createAccountManager({
		store: createFileStore(),
		config: getRotationConfig(loadPluginConfig()),
		refresh: refreshAccessToken,
		client,
	});
	const captureTokens = (tokens: {
		type: string;
		access?: string;
		refresh?: string;
		expires?: number;
	}) => {
		if (tokens.type === "success" && tokens.access && tokens.refresh) {
			loginCaptureManager.captureLogin({
				access: tokens.access,
				refresh: tokens.refresh,
				expires: tokens.expires ?? 0,
			});
		}
	};

	return {
		auth: {
			provider: PROVIDER_ID,
			/**
			 * Loader function that configures OAuth authentication and request handling
			 *
			 * This function:
			 * 1. Validates OAuth authentication
			 * 2. Extracts ChatGPT account ID from access token
			 * 3. Loads user configuration from opencode.json
			 * 4. Fetches Codex system instructions from GitHub (cached)
			 * 5. Returns SDK configuration with custom fetch implementation
			 *
			 * @param getAuth - Function to retrieve current auth state
			 * @param provider - Provider configuration from opencode.json
			 * @returns SDK configuration object or empty object for non-OAuth auth
			 */
			async loader(getAuth: () => Promise<Auth>, provider: unknown) {
				const auth = await getAuth();

				// Only handle OAuth auth type, skip API key auth
				if (auth.type !== "oauth") {
					return {};
				}

				// Extract ChatGPT account ID from JWT access token
				const decoded = decodeJWT(auth.access);
				const accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id;

				if (!accountId) {
					logDebug(
						`[${PLUGIN_NAME}] ${ERROR_MESSAGES.NO_ACCOUNT_ID} (skipping plugin)`,
					);
					return {};
				}
				// Extract user configuration (global + per-model options)
				const providerConfig = provider as
					| { options?: Record<string, unknown>; models?: UserConfig["models"] }
					| undefined;
				const userConfig: UserConfig = {
					global: providerConfig?.options || {},
					models: providerConfig?.models || {},
				};

				// Load plugin configuration and determine CODEX_MODE
				// Priority: CODEX_MODE env var > config file > default (true)
				const pluginConfig = loadPluginConfig();
				const codexMode = getCodexMode(pluginConfig);

				// loader runs once per session; the store + manager are session-scoped
				// (the manager's in-memory mirror-dedup cache lives for the session).
				// Multi-account rotation setup
				const rotationConfig = getRotationConfig(pluginConfig);
				const accountStore = createFileStore();
				const accountManager = createAccountManager({
					store: accountStore,
					config: rotationConfig,
					refresh: refreshAccessToken,
					client,
				});
				// Seed the pool from the current oauth slot for existing single-account users.
				accountManager.seedFromAuth(auth);

				// Return SDK configuration
				return {
					apiKey: DUMMY_API_KEY,
					baseURL: CODEX_BASE_URL,
					/**
					 * Custom fetch implementation for Codex API
					 *
					 * Handles:
					 * - Token refresh when expired
					 * - URL rewriting for Codex backend
					 * - Request body transformation
					 * - OAuth header injection
					 * - SSE to JSON conversion for non-tool requests
					 * - Error handling and logging
					 *
					 * @param input - Request URL or Request object
					 * @param init - Request options
					 * @returns Response from Codex API
					 */
					async fetch(
						input: Request | string | URL,
						init?: RequestInit,
					): Promise<Response> {
						// Extract and rewrite URL for Codex backend
						const originalUrl = extractRequestUrl(input);
						const url = rewriteUrlForCodex(originalUrl);

						// Capture original stream value before transformation
						const originalBody = init?.body ? JSON.parse(init.body as string) : {};
						const isStreaming = originalBody.stream === true;

						// Transform request body with model-specific Codex instructions
						const transformation = await transformRequestForCodex(
							init,
							url,
							userConfig,
							codexMode,
						);
						const requestInit = transformation?.updatedInit ?? init;

						// Build the per-account send: headers carry the selected account's
						// token + id; applyActive mirrors it into the opencode slot.
						const doFetch = async (account: AccountRecord): Promise<Response> => {
							await accountManager.applyActive(account);
							const headers = createCodexHeaders(
								requestInit,
								account.id,
								account.access,
								{
									model: transformation?.body.model,
									promptCacheKey: (transformation?.body as any)?.prompt_cache_key,
								},
							);
							return fetch(url, { ...requestInit, headers });
						};

						// Select an account, refresh, send, and fall back on hard limits.
						let account: AccountRecord;
						let response: Response;
						try {
							const result = await rotatingFetch({
								manager: accountManager,
								config: rotationConfig,
								doFetch,
								inspectUsageLimit: inspectUsageLimitResponse,
							});
							account = result.account;
							response = result.response;
						} catch (e) {
							if (e instanceof NoUsableAccountError) {
								throw new Error(ERROR_MESSAGES.NO_USABLE_ACCOUNTS, { cause: e });
							}
							throw e;
						}

						// Log response
						logRequest(LOG_STAGES.RESPONSE, {
							status: response.status,
							ok: response.ok,
							statusText: response.statusText,
							headers: Object.fromEntries(response.headers.entries()),
						});

						if (!response.ok) {
							return await handleErrorResponse(response);
						}

						// Record usage so the next turn can switch if over threshold.
						accountManager.recordResponseUsage(account.id, response.headers);
						return await handleSuccessResponse(response, isStreaming);
					},
				};
			},
				methods: [
					{
						label: AUTH_LABELS.OAUTH,
						type: "oauth" as const,
					/**
					 * OAuth authorization flow
					 *
					 * Steps:
					 * 1. Generate PKCE challenge and state for security
					 * 2. Start local OAuth callback server on port 1455
					 * 3. Open browser to OpenAI authorization page
					 * 4. Wait for user to complete login
					 * 5. Exchange authorization code for tokens
					 *
					 * @returns Authorization flow configuration
					 */
					authorize: async () => {
						const { pkce, state, url } = await createAuthorizationFlow();
						const serverInfo = await startLocalOAuthServer({ state });

						// Attempt to open browser automatically
						openBrowserUrl(url);

						if (!serverInfo.ready) {
							serverInfo.close();
							return buildManualOAuthFlow(pkce, url);
						}

						return {
							url,
							method: "auto" as const,
							instructions: AUTH_LABELS.INSTRUCTIONS,
							callback: async () => {
								const result = await serverInfo.waitForCode(state);
								serverInfo.close();

								if (!result) {
									return { type: "failed" as const };
								}

								const tokens = await exchangeAuthorizationCode(
									result.code,
									pkce.verifier,
									REDIRECT_URI,
								);

								if (tokens?.type === "success") {
									captureTokens(tokens);
									return tokens;
								}
								return { type: "failed" as const };
							},
						};
					},
					},
					{
						label: AUTH_LABELS.OAUTH_MANUAL,
						type: "oauth" as const,
						authorize: async () => {
							const { pkce, url } = await createAuthorizationFlow();
							return buildManualOAuthFlow(pkce, url);
						},
					},
					{
						label: AUTH_LABELS.API_KEY,
						type: "api" as const,
					},
			],
		},
	};
};

export default OpenAIAuthPlugin;
