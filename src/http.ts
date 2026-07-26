/** Origin only — never the path, since e.g. a Discord webhook URL's path is itself the credential. */
function safeOrigin(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return "unknown origin";
	}
}

/**
 * Sends one request with an abort timeout, returning the response for the caller to judge.
 *
 * Transport rejections are re-thrown without their `cause`: Deno embeds the full request URL there,
 * and for a Discord webhook the URL's path _is_ the credential. `label` and the origin keep the
 * message diagnostic without carrying secrets.
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
		const reason = error instanceof Error ? error.name : "unknown error";

		// Deliberately no `cause`: Deno embeds the full request URL in a fetch rejection's cause,
		// which for a Discord webhook is the credential. Do not "restore" it for diagnostics.
		// oxlint-disable-next-line preserve-caught-error
		throw new Error(`${label} request failed (${reason}) for ${safeOrigin(url)}`);
	}
}

export { sendRequest };
