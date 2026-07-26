import { describe, expect, test, vi } from "vitest";

import { sendRequest } from "@/http.ts";

describe("sendRequest", () => {
	test("applies an abort timeout while passing the caller's init through", async () => {
		const fetchMock = vi.fn((_url: string | URL, _init?: RequestInit) =>
			Promise.resolve(new Response("ok"))
		);
		vi.stubGlobal("fetch", fetchMock);

		await sendRequest("https://example.com/x", { method: "POST", headers: { A: "1" } }, 1000);

		const init = fetchMock.mock.calls[0]?.[1];
		// The timeout is the whole reason this helper exists — a request without one stalls the cron
		// tick, so this assertion is the module's actual contract.
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(init?.method).toBe("POST");
		expect(init?.headers).toEqual({ A: "1" });
	});

	test("lets a transport rejection through untouched, cause chain intact", async () => {
		const transportError = new TypeError("fetch failed", { cause: new Error("dns error") });
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.reject(transportError))
		);

		let caught: unknown;

		await sendRequest("https://example.com/x", {}, 1000).catch((error: unknown) => {
			caught = error;
		});

		// Not re-wrapped: callers and `poll`'s log.error see Deno's original error, which carries the
		// transport failure and request URL in its cause. See sendRequest's JSDoc.
		expect(caught).toBe(transportError);
		expect((caught as Error).cause).toBeInstanceOf(Error);
	});
});
