/**
 * The single outbound-`fetch` chokepoint: applies the caller's abort timeout and nothing else.
 *
 * Its only job is that `grep -rn "fetch(" src/` returns this file alone, so a new call site
 * physically cannot forget a timeout — and a request without one stalls the whole cron tick, which
 * is the reason the per-caller timeout constants exist at all.
 *
 * Rejections propagate untouched. Deno's own `TypeError` already carries the transport failure and
 * the request URL through its `cause` chain, which is the diagnostic the maintainer wants in the
 * log. Note that URL includes a Discord webhook's path, which is a bearer credential — accepted on
 * a single-operator deploy; revisit if log access ever widens. Wrapping the rejection to relabel it
 * would only repeat what the stack trace and each caller's own not-ok message already say.
 */
function sendRequest(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
	return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

export { sendRequest };
