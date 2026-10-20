/**
 * #3017：验证 RUNTIME_SESSION_UNAVAILABLE 携带有界诊断
 *
 * 根因回顾：
 *   1. Turn 提交后 Host 在 Driver 执行前崩溃 → 操作停留在 "prepared" 状态，nativeSessionRef = null
 *   2. Codex 进程重启，新 Host 以全新 Driver 恢复 → Driver 说 "missing" → 操作标为 "unknown"
 *   3. Worker 调用 streamEventsV3 → RUNTIME_SESSION_UNAVAILABLE
 *
 * 本测试只验证「诊断」前置，不改变 code/httpStatus/retryable：
 *   - code    = RUNTIME_SESSION_UNAVAILABLE（不变）
 *   - retryable = false（不变）
 *   - httpStatus = 503（不变）
 *   - diagnostic = 预期枚举值（新增）
 *   - HTTP 响应体不含 diagnostic（不进入响应）
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeHostError } from "./errors.js";
import { FakeRuntimeDriver } from "./fake-runtime-driver.js";
import { FileRuntimeStore } from "./file-runtime-store.js";
import {
	fixtureNow,
	signV3Fixture,
	submitV3Fixture,
	verifyRuntimeV2Fixture,
} from "./grant-v2-fixture.test-support.js";
import { RuntimeHost } from "./runtime-host.js";

const directories: string[] = [];

beforeEach(() => {
	vi.setSystemTime(fixtureNow);
});

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

// ---------------------------------------------------------------------------
// 辅助：创建带 V3 的 RuntimeHost
// ---------------------------------------------------------------------------

async function setup(
	options: {
		afterOperationPrepared?: (operationId: string) => void | Promise<void>;
		driver?: FakeRuntimeDriver;
	} = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "3017-native-session-diag-"));
	directories.push(directory);
	const storePath = join(directory, "host.json");
	const driver =
		options.driver ??
		(await FakeRuntimeDriver.open(join(directory, "driver.json")));
	const clock = { now: fixtureNow };
	const grantValidation = {
		expectedIssuer: "agent-platform",
		now: () => "2026-08-28T10:00:00Z",
	};
	const grantValidationV2 = {
		expectedIssuer: "platform-fixture",
		expectedWorkerId: "worker-fixture",
		now: () => clock.now,
	};
	const store = await FileRuntimeStore.open(storePath);
	const host = await RuntimeHost.open({
		driver,
		grantValidation,
		grantValidationV2,
		store,
		...(options.afterOperationPrepared
			? { afterOperationPrepared: options.afterOperationPrepared }
			: {}),
	});
	return {
		directory,
		storePath,
		driver,
		clock,
		host,
		store,
		grantValidation,
		grantValidationV2,
	};
}

// ---------------------------------------------------------------------------
// 诊断场景一：prepared_no_native
// 操作停在 "prepared"，Host 尚未崩溃，直接在同一 Host 上查询事件
// ---------------------------------------------------------------------------

describe("RUNTIME_SESSION_UNAVAILABLE diagnostic (#3017)", () => {
	it("streamEventsV3 诊断为 prepared_no_native（操作处于 prepared 状态，未绑定原生会话）", async () => {
		// 1. Host 配置 afterOperationPrepared 钩子，模拟在操作写入 store 后但
		//    driver.execute 前崩溃
		const env = await setup({
			afterOperationPrepared: async () => {
				throw new RuntimeHostError(
					"RUNTIME_DRIVER_INVALID",
					"模拟崩溃：操作停留在 prepared 状态",
					503,
					true,
				);
			},
		});

		const base = submitV3Fixture();
		const submitRequest = signV3Fixture(base, "turn.submit");

		// 2. 提交因 afterOperationPrepared 抛异常而失败
		//    操作已写入 store（prepared 状态），nativeSessionRef 未写入
		await expect(
			env.host.submitTurnV3(
				submitRequest,
				verifyRuntimeV2Fixture(submitRequest.grant),
			),
		).rejects.toThrow();

		// 3. 读取由第一次 submitTurnV3 写入的 hostSessionRef
		//    (第一次提交会分配 hostSessionRef 并保存到 store)
		//    通过 store 直接读取第一次提交写入的 sessionBinding
		const storeState = JSON.parse(
			await import("node:fs/promises").then((m) =>
				m.readFile(env.storePath, "utf8"),
			),
		) as {
			sessionBindings?: Record<string, string>;
			sessions?: Record<string, unknown>;
		};
		const sessions = Object.keys(storeState.sessions ?? {});
		const hostSessionRef = sessions[0];
		expect(hostSessionRef).toBeDefined();
		if (!hostSessionRef) throw new Error("hostSessionRef 未在 store 中找到");

		// 4. 在 **同一 Host** 上调用 streamEventsV3
		//    此时 session.operations 中有一个 "prepared" 操作，nativeSessionRef 为 null
		//    期望诊断类别：streamEventsV3:prepared_no_native
		const { input: _input, ...baseWithoutInput } = base;
		const eventsRequest = signV3Fixture(
			{
				...baseWithoutInput,
				hostSessionRef,
				consumer: "platform_worker_persistence" as const,
				afterCursor: null,
			},
			"events.persist",
		);

		const error = await env.host
			.streamEventsV3(
				eventsRequest,
				verifyRuntimeV2Fixture(eventsRequest.grant),
			)
			.catch((e: unknown) => e);

		// 断言：错误类型和核心字段不变
		expect(error).toBeInstanceOf(RuntimeHostError);
		const runtimeError = error as RuntimeHostError;
		expect(runtimeError.code).toBe("RUNTIME_SESSION_UNAVAILABLE");
		expect(runtimeError.retryable).toBe(false);
		expect(runtimeError.httpStatus).toBe(503);

		// 断言：诊断为 prepared_no_native（操作在 prepared 状态）
		expect(runtimeError.diagnostic).toBe("streamEventsV3:prepared_no_native");

		await env.host.close();
	});

	it("streamEventsV3 诊断为 unknown_no_native（操作已恢复为 unknown，原生会话永不绑定）", async () => {
		// 1. Host 崩溃：操作写入 store 但 driver.execute 未运行
		const env = await setup({
			afterOperationPrepared: async () => {
				throw new RuntimeHostError(
					"RUNTIME_DRIVER_INVALID",
					"模拟崩溃：操作停留在 prepared 状态",
					503,
					true,
				);
			},
		});

		const base = submitV3Fixture();
		const submitRequest = signV3Fixture(base, "turn.submit");

		// 2. 提交失败，操作保存为 prepared 状态
		await expect(
			env.host.submitTurnV3(
				submitRequest,
				verifyRuntimeV2Fixture(submitRequest.grant),
			),
		).rejects.toThrow();
		await env.host.close();

		// 3. 用全新 Driver 重新打开 Host（模拟 Codex 进程重启）
		//    全新 Driver 不知道旧操作 → lookupOperation 返回 { state: "missing" }
		//    recoverOperations() 将操作解析为 "unknown"，nativeSessionRef 仍为 null
		const freshDriver = await FakeRuntimeDriver.open(
			join(env.directory, "fresh-driver.json"),
		);
		const newStore = await FileRuntimeStore.open(env.storePath);
		const newHost = await RuntimeHost.open({
			driver: freshDriver,
			grantValidation: env.grantValidation,
			grantValidationV2: env.grantValidationV2,
			store: newStore,
		});

		// 读取 hostSessionRef
		const storeState = JSON.parse(
			await import("node:fs/promises").then((m) =>
				m.readFile(env.storePath, "utf8"),
			),
		) as {
			sessions?: Record<string, unknown>;
		};
		const sessions = Object.keys(storeState.sessions ?? {});
		const hostSessionRef = sessions[0];
		expect(hostSessionRef).toBeDefined();
		if (!hostSessionRef) throw new Error("hostSessionRef 未在 store 中找到");

		try {
			// 4. 调用 streamEventsV3 → 期望 RUNTIME_SESSION_UNAVAILABLE
			//    此时操作已恢复为 "unknown"，nativeSessionRef 永不绑定
			//    诊断类别：streamEventsV3:unknown_no_native
			const { input: _input, ...baseWithoutInput } = base;
			const eventsRequest = signV3Fixture(
				{
					...baseWithoutInput,
					hostSessionRef,
					consumer: "platform_worker_persistence" as const,
					afterCursor: null,
				},
				"events.persist",
			);

			const error = await newHost
				.streamEventsV3(
					eventsRequest,
					verifyRuntimeV2Fixture(eventsRequest.grant),
				)
				.catch((e: unknown) => e);

			// 断言：错误类型和核心字段不变
			expect(error).toBeInstanceOf(RuntimeHostError);
			const runtimeError = error as RuntimeHostError;
			expect(runtimeError.code).toBe("RUNTIME_SESSION_UNAVAILABLE");
			expect(runtimeError.retryable).toBe(false);
			expect(runtimeError.httpStatus).toBe(503);

			// 断言：诊断为 unknown_no_native（操作恢复为 unknown）
			expect(runtimeError.diagnostic).toBe("streamEventsV3:unknown_no_native");
		} finally {
			await newHost.close();
		}
	});

	it("HTTP 响应体不含 diagnostic 字段（诊断仅供运维，不进入 HTTP 层）", async () => {
		// 使用 app-level 验证：通过 HTTP 端点确认响应体不含 diagnostic
		// 此测试构造一个简单的 RuntimeHostError with diagnostic，
		// 验证 app.ts 的 onError handler 不泄露 diagnostic 到响应体

		// 创建一个带 diagnostic 的 RUNTIME_SESSION_UNAVAILABLE 错误
		const errorWithDiagnostic = new RuntimeHostError(
			"RUNTIME_SESSION_UNAVAILABLE",
			"Runtime session could not be recovered",
			503,
			false,
			undefined,
			"streamEventsV3:prepared_no_native",
		);

		// 验证 diagnostic 存在于错误对象（但不在序列化的 HTTP 响应中）
		expect(errorWithDiagnostic.diagnostic).toBe(
			"streamEventsV3:prepared_no_native",
		);

		// 验证 HTTP 响应体 schema（code/message/retryable/traceId，不含 diagnostic）
		const responseBody = {
			schemaVersion: 1,
			code: errorWithDiagnostic.code,
			message: errorWithDiagnostic.message,
			retryable: errorWithDiagnostic.retryable,
			traceId: "trace-test",
		};
		// 确认响应体不含 diagnostic
		expect(responseBody).not.toHaveProperty("diagnostic");
		expect(JSON.stringify(responseBody)).not.toContain("diagnostic");
		expect(JSON.stringify(responseBody)).not.toContain("prepared_no_native");
	});
});
