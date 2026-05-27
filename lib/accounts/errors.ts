/** Thrown when no account in the pool can serve a request. */
export class NoUsableAccountError extends Error {
	constructor(message = "No usable ChatGPT account available") {
		super(message);
		this.name = "NoUsableAccountError";
	}
}
