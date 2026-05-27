import {
	readFileSync,
	writeFileSync,
	renameSync,
	existsSync,
	mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { PLUGIN_NAME } from "../constants.js";
import type { AccountPool } from "../types.js";

/** Path to the multi-account pool file (contains refresh tokens). */
export const ACCOUNTS_PATH = join(
	homedir(),
	".opencode",
	"openai-codex-accounts.json",
);

/** A fresh, empty pool. */
export function emptyPool(): AccountPool {
	return { version: 1, activeId: null, accounts: [] };
}

/** Read/write port over the on-disk account pool. */
export interface AccountStore {
	/** Read the current pool from disk (empty pool if missing/corrupt). */
	read(): AccountPool;
	/** Atomically persist the pool with 0600 permissions. */
	write(pool: AccountPool): void;
}

/**
 * File-backed account store. Reads re-read from disk every time so concurrent
 * opencode sessions sharing the file see each other's writes (last-writer-wins).
 */
export function createFileStore(path: string = ACCOUNTS_PATH): AccountStore {
	return {
		read(): AccountPool {
			if (!existsSync(path)) return emptyPool();
			try {
				const parsed = JSON.parse(readFileSync(path, "utf-8")) as AccountPool;
				if (!parsed || !Array.isArray(parsed.accounts)) return emptyPool();
				return { version: 1, activeId: parsed.activeId ?? null, accounts: parsed.accounts };
			} catch (error) {
				console.warn(
					`[${PLUGIN_NAME}] Failed to read account pool at ${path}:`,
					(error as Error).message,
				);
				return emptyPool();
			}
		},
		write(pool: AccountPool): void {
			const dir = dirname(path);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			const tmp = `${path}.${process.pid}.tmp`;
			// mode 0600 — file holds refresh tokens
			writeFileSync(tmp, JSON.stringify(pool, null, 2), { encoding: "utf-8", mode: 0o600 });
			renameSync(tmp, path);
		},
	};
}
