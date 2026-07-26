import { describe, expect, test, vi } from "vitest";

import { fetchOk, sendRequest } from "@/http.ts";

describe("fetchOk", () => {
	test("returns the response on a 200", async () => {
		const response = new Response("ok");
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(response))
		);

		await expect(fetchOk("https://example.com/thing", "Test API", {}, 1000)).resolves.toBe(
			response
		);
	});

	test("throws with the label, status, and body slice on a non-ok response, and consumes the body", async () => {
		const response = new Response("x".repeat(300), { status: 404 });
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(response))
		);

		await expect(fetchOk("https://example.com/thing", "Test API", {}, 1000)).rejects.toThrow(
			`Test API 404: ${"x".repeat(200)}`
		);
		expect(response.bodyUsed).toBe(true);
	});

	test("truncates a body longer than 200 chars", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response("y".repeat(250), { status: 500 })))
		);

		await expect(fetchOk("https://example.com/thing", "Test API", {}, 1000)).rejects.toThrow(
			new RegExp(`^Test API 500: y{200}$`)
		);
	});
});

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
