import { afterEach, expect, it, vi } from "vitest";
import {
	searchDirectoryEmployees,
	validateEmployeeDirectory,
} from "./employee-directory";

const options = {
	url: "https://employees.example/users",
	serviceKey: "test-key",
};
afterEach(() => vi.unstubAllGlobals());

it("rejects insecure endpoints and credentials in URLs", () => {
	for (const url of [
		"http://employees.example/users",
		"https://user:secret@employees.example/users",
		"https://employees.example/users#fragment",
	]) {
		expect(() => validateEmployeeDirectory({ ...options, url })).toThrow();
	}
});

it("matches names and email case-insensitively and returns only the minimal projection", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json([
				{
					name: "张三",
					email: "ZhangSan@example.com",
					iamId: "external-id",
					phone: "hidden",
				},
				{ name: "No IAM", email: "none@example.com" },
			]),
		),
	);
	for (const query of ["张三", "zhangsan"]) {
		await expect(
			searchDirectoryEmployees(options, query, AbortSignal.timeout(1000)),
		).resolves.toEqual([{ name: "张三", email: "zhangsan@example.com" }]);
	}
});

it("rejects malformed, duplicate and oversized upstream responses", async () => {
	const employee = { name: "Alice", email: "alice@example.com", iamId: "1" };
	for (const payload of [
		{ data: [employee] },
		[employee, employee],
		[{ ...employee, email: null }],
	]) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(payload)),
		);
		await expect(
			searchDirectoryEmployees(options, "alice", AbortSignal.timeout(1000)),
		).rejects.toThrow();
	}
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(" ".repeat(5 * 1024 * 1024 + 1))),
	);
	await expect(
		searchDirectoryEmployees(options, "alice", AbortSignal.timeout(1000)),
	).rejects.toThrow("too large");
});
