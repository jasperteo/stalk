import { describe, expect, test, vi } from "vitest";

import { sendRequest } from "@/http.ts";

describe("sendRequest", () => {
	test("labels a rejecting fetch and preserves the original error as cause", async () => {
		const transportError = new TypeError("network error");
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.reject(transportError))
		);

		let caught: unknown;

		await sendRequest("https://example.com/webhooks/123/token", "Test API", {}, 1000).catch(
			(error: unknown) => {
				caught = error;
			}
		);

		expect(caught).toBeInstanceOf(Error);
		const message = (caught as Error).message;
		// The label and the failure's constructor name are what make a log line diagnosable without
		// opening the cause.
		expect(message).toContain("Test API");
		expect(message).toContain("TypeError");
		expect(message).toContain("https://example.com/webhooks/123/token");
		// The original is kept intact, by deliberate maintainer decision — see sendRequest's JSDoc.
		// The request URL this carries includes the webhook path, which is a bearer credential.
		expect((caught as Error).cause).toBe(transportError);
	});
});
