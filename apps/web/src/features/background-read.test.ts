import { afterEach, describe, expect, it, vi } from "vitest";
import {
	markUserRead,
	queryUserReading,
	readFailed,
	retainContent,
	retainedContentAt,
	userReadFailed,
	userReadPending,
} from "./background-read.js";

const always = () => true;
const never = () => false;

function query(input: Partial<Parameters<typeof readFailed>[0]> = {}) {
	return {
		data: undefined,
		error: null,
		isError: false,
		dataUpdatedAt: 0,
		errorUpdatedAt: 0,
		...input,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("background reads keep shown content (#3387)", () => {
	it("reports a failure only without content or when the failure is not retryable", () => {
		expect(readFailed(query(), always)).toBe(false);
		expect(
			readFailed(query({ isError: true, errorUpdatedAt: 10 }), always),
		).toBe(true);
		const background = query({
			data: { kind: "ready" },
			isError: true,
			dataUpdatedAt: 10,
			errorUpdatedAt: 20,
		});
		expect(readFailed(background, always)).toBe(false);
		expect(readFailed(background, never)).toBe(true);
	});

	it("shows a user-initiated failure until content is read again", () => {
		vi.useFakeTimers();
		const owner = {};
		vi.setSystemTime(100);
		markUserRead(owner, 10);
		// 用户读取进行中：内容保留，读取行由调用方结合 isFetching 显示。
		expect(userReadPending(owner, { contentAt: 10, failureAt: 0 })).toBe(true);
		expect(
			queryUserReading(
				{ isFetching: true, dataUpdatedAt: 10, errorUpdatedAt: 0 },
				owner,
			),
		).toBe(true);
		const failed = query({
			data: { kind: "ready" },
			isError: true,
			dataUpdatedAt: 10,
			errorUpdatedAt: 120,
		});
		expect(readFailed(failed, always, owner)).toBe(true);
		// 失败后按「重试」仍是同一次用户读取：重读进行中失败继续显示，不回到旧内容。
		vi.setSystemTime(200);
		markUserRead(owner, 10);
		expect(readFailed(failed, always, owner)).toBe(true);
		expect(userReadPending(owner, { contentAt: 10, failureAt: 120 })).toBe(
			false,
		);
		// 读到内容后，之后的后台重读失败不再替换。
		const later = query({
			data: { kind: "ready" },
			isError: true,
			dataUpdatedAt: 300,
			errorUpdatedAt: 400,
		});
		expect(readFailed(later, always, owner)).toBe(false);
		expect(userReadFailed(owner, { contentAt: 300, failureAt: 400 })).toBe(
			false,
		);
	});

	it("does not flip to a failure while a user read waits on an earlier background failure", () => {
		vi.useFakeTimers();
		const owner = {};
		vi.setSystemTime(500);
		markUserRead(owner, 10);
		// 先前的后台失败（errorUpdatedAt 早于这次用户读取）不算这次读取的结果。
		expect(
			readFailed(
				query({
					data: { kind: "ready" },
					isError: true,
					dataUpdatedAt: 10,
					errorUpdatedAt: 300,
				}),
				always,
				owner,
			),
		).toBe(false);
	});

	it("retains content returned before a background failure written as data", () => {
		vi.useFakeTimers();
		const owner = {};
		const options = {
			isContent: (state: { kind: string }) => state.kind === "ready",
			isRetryableFailure: (state: { kind: string; retryable?: boolean }) =>
				state.kind === "unavailable" && state.retryable === true,
		};
		const ready = { kind: "ready", items: ["shown"] };
		expect(retainContent(owner, ready, { ...options, updatedAt: 10 })).toBe(
			ready,
		);
		expect(retainedContentAt(owner)).toBe(10);
		const failure = { kind: "unavailable", retryable: true };
		expect(retainContent(owner, failure, { ...options, updatedAt: 20 })).toBe(
			ready,
		);
		// 用户发起的读取失败原样返回。
		vi.setSystemTime(30);
		markUserRead(owner, retainedContentAt(owner));
		expect(retainContent(owner, failure, { ...options, updatedAt: 40 })).toBe(
			failure,
		);
	});

	it("drops retained content after a definitive result or a reset", () => {
		const options = {
			isContent: (state: { kind: string }) => state.kind === "ready",
			isRetryableFailure: (state: { kind: string; retryable?: boolean }) =>
				state.kind === "unavailable" && state.retryable === true,
		};
		const ready = { kind: "ready" };
		const failure = { kind: "unavailable", retryable: true };
		for (const reset of [
			{ kind: "unavailable", retryable: false },
			{ kind: "loading" },
		]) {
			const owner = {};
			retainContent(owner, ready, { ...options, updatedAt: 10 });
			expect(retainContent(owner, reset, { ...options, updatedAt: 20 })).toBe(
				reset,
			);
			expect(retainContent(owner, failure, { ...options, updatedAt: 30 })).toBe(
				failure,
			);
		}
		// 新的读取范围（换身份或查询）不带上一个范围的内容。
		const other = {};
		expect(retainContent(other, failure, { ...options, updatedAt: 40 })).toBe(
			failure,
		);
	});
});
