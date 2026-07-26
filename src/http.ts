/**
 * Sends one request with an abort timeout, returning the response for the caller to judge.
 *
 * Transport rejections are re-thrown with the original attached as `cause`, so the log keeps the
 * full diagnostic — Deno puts the underlying failure and the request URL there. That URL includes a
 * Discord webhook's path, which is a bearer credential, so anything with read access to the logs
 * can post to the channel. Deliberate call by the maintainer: on a single-operator deploy the
 * diagnostic is worth more than the exposure. Revisit if log access ever widens.
 */
async function sendRequest(
	url: string,
	label: string,
	init: RequestInit,
	timeoutMs: number
): Promise<Response> {
	try {
		return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
	} catch (error) {
		// `Error.isError` rather than `instanceof`: it brands-checks, so it stays correct for an error
		// crossing a realm boundary (where `instanceof` fails) and rejects a plain object wearing
		// `Error.prototype` (where `instanceof` succeeds).
		const reason = Error.isError(error) ? error.name : "unknown error";

		throw new Error(`${label} request failed (${reason}) for ${url}`, { cause: error });
	}
}

export { sendRequest };
