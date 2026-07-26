import { describe, expect, test, vi } from "vitest";

import { sendRequest } from "@/http.ts";

describe("sendRequest", () => {
	test("sanitizes a rejecting fetch: message carries the origin but not the URL path, and cause is undefined", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.reject(new TypeError("network error")))
		);

		let caught: unknown;

		await sendRequest(
			"https://example.com/webhooks/123/super-secret-token",
			"Test API",
			{},
			1000
		).catch((error: unknown) => {
			caught = error;
		});

		expect(caught).toBeInstanceOf(Error);
		const message = (caught as Error).message;
		expect(message).toContain("https://example.com");
		expect(message).not.toContain("super-secret-token");
		expect(message).not.toContain("/webhooks/123");
		expect((caught as Error).cause).toBeUndefined();
	});
});
