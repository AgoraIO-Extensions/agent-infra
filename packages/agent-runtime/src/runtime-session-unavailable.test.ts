/**
 * 验证 #3017：负载下 nativeSessionRef 未绑定时被当成不可恢复
 *
 * 根因：Codex 进程重启后 Driver 说 "missing"，RuntimeHost 恢复时把操作标为
 * "unknown" 且不写 nativeSessionRef。Worker 随后调用 streamEvents，Host 检查
 * session.nativeSessionRef 为空，nativeRequired() 抛 RUNTIME_SESSION_UNAVAILABLE
 * retryable=false → Worker 终态失败。
 *
 * 修复：在 nativeSessionRef 为空（会话尚未绑定原生进程）时，抛 retryable=true，
 * 允许 Worker 重新提交 Turn 后继续排空；Driver 层面真正丢失会话时产生的
 * RUNTIME_SESSION_RECOVERY_FAILED 仍保持 retryable=false，不受影响。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
	} = {},
) {
	const directory = await mkdtemp(
		join(tmpdir(), "runtime-session-unavailable-"),
	);
	directories.push(directory);
	const storePath = join(directory, "host.json");
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
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

/** 从 store JSON 文件中读取 hostSessionRef（用于中途崩溃的测试场景） */
async function readHostSessionRefFromStore(
	storePath: string,
	agentId: string,
	conversationId: string,
): Promise<string | undefined> {
	const raw = JSON.parse(await readFile(storePath, "utf8")) as {
		sessionBindings?: Record<string, string>;
	};
	const key = JSON.stringify([agentId, conversationId]);
	return raw.sessionBindings?.[key];
}

/**
 * AC-1 红灯测试（修复前失败，修复后通过）
 *
 * 场景：
 * 1. Turn 提交后 Host 在 Driver 执行前崩溃 → 操作停留在 "prepared" 状态，nativeSessionRef = null
 * 2. Codex 进程重启，新 Host 启动，恢复时 Driver 说 "missing" → 操作标为 "unknown"，nativeSessionRef 仍为 null
 * 3. Worker 调用 streamEventsV3 → 期望 RUNTIME_SESSION_UNAVAILABLE retryable=true（可重试）
 *    修复前：retryable=false（终态），测试失败（红灯）
 *    修复后：retryable=true（可重试），测试通过（绿灯）
 */
describe("RUNTIME_SESSION_UNAVAILABLE retryable when native session is unbound (#3017)", () => {
	it("streamEventsV3 throws retryable RUNTIME_SESSION_UNAVAILABLE when nativeSessionRef is not yet bound", async () => {
		// 用于在 afterOperationPrepared 中捕获 storePath
		let capturedStorePath = "";

		// 1. 创建 Host，在 afterOperationPrepared 中模拟崩溃
		//    操作写入 store（"prepared" 状态，nativeSessionRef = null），dispatch 终止
		const env = await setup({
			afterOperationPrepared: async () => {
				// 抛异常模拟崩溃：操作停留在 "prepared" 状态
				throw new RuntimeHostError(
					"RUNTIME_DRIVER_INVALID",
					"Simulated crash before driver execute",
					503,
					true,
				);
			},
		});
		capturedStorePath = env.storePath;

		const base = submitV3Fixture();
		const submitRequest = signV3Fixture(base, "turn.submit");
		// 提交因 afterOperationPrepared 抛异常而失败（模拟崩溃）
		await expect(
			env.host.submitTurnV3(
				submitRequest,
				verifyRuntimeV2Fixture(submitRequest.grant),
			),
		).rejects.toThrow();

		// 从 store 文件中读取 hostSessionRef（操作已保存但崩溃前尚未完成）
		const hostSessionRef = await readHostSessionRefFromStore(
			capturedStorePath,
			base.agentId,
			base.conversationId,
		);
		expect(hostSessionRef).toBeDefined();
		if (!hostSessionRef) throw new Error("hostSessionRef not found in store");

		await env.host.close();

		// 2. 用同一 store + 全新 Driver 打开新 Host（模拟 Codex 进程重启）
		//    全新 Driver 不知道旧操作 → lookupOperation 返回 { state: "missing" }
		//    recoverOperations() 将操作解析为 "unknown"，nativeSessionRef 仍为 null
		const freshDriver = await FakeRuntimeDriver.open(
			join(env.directory, "fresh-driver.json"),
		);
		const newStore = await FileRuntimeStore.open(capturedStorePath);
		const newHost = await RuntimeHost.open({
			driver: freshDriver,
			grantValidation: env.grantValidation,
			grantValidationV2: env.grantValidationV2,
			store: newStore,
		});

		try {
			// 3. 构造有效的 events.persist 请求（需要有效的非空 hostSessionRef）
			//    注意：去掉 input 字段（events.persist schema 使用 strictObject，不允许多余字段）
			const { input: _input, ...baseWithoutInput } = base;
			const eventsRequest = signV3Fixture(
				{
					...baseWithoutInput,
					hostSessionRef: hostSessionRef,
					consumer: "platform_worker_persistence" as const,
					afterCursor: null,
				},
				"events.persist",
			);

			// 4. 调用 streamEventsV3 → 期望 RUNTIME_SESSION_UNAVAILABLE retryable=true
			//    修复前：retryable=false（终态，测试失败）
			//    修复后：retryable=true（可重试，测试通过）
			await expect(
				newHost.streamEventsV3(
					eventsRequest,
					verifyRuntimeV2Fixture(eventsRequest.grant),
				),
			).rejects.toMatchObject({
				code: "RUNTIME_SESSION_UNAVAILABLE",
				retryable: true, // ← 修复前此处为 false，测试失败（红灯）
			});
		} finally {
			await newHost.close();
		}
	});

	/**
	 * AC-2 验证正常路径不受影响（修复前后都应通过）
	 *
	 * 场景：Turn 正常提交，nativeSessionRef 绑定后，streamEventsV3 应正常工作
	 * （不抛 RUNTIME_SESSION_UNAVAILABLE）。
	 */
	it("streamEventsV3 succeeds when nativeSessionRef is properly bound", async () => {
		// 1. 正常提交，Driver 受理，nativeSessionRef 绑定
		const env = await setup();
		const base = submitV3Fixture();
		const submitRequest = signV3Fixture(base, "turn.submit");
		const accepted = await env.host.submitTurnV3(
			submitRequest,
			verifyRuntimeV2Fixture(submitRequest.grant),
		);
		expect(accepted.result.outcome).toBe("accepted");

		// 2. 构造 events.persist 请求（使用已绑定的 hostSessionRef）
		const { input: _input2, ...base2WithoutInput } = base;
		const eventsRequest = signV3Fixture(
			{
				...base2WithoutInput,
				hostSessionRef: accepted.hostSessionRef,
				consumer: "platform_worker_persistence" as const,
				afterCursor: null,
			},
			"events.persist",
		);

		// 3. streamEventsV3 应成功返回（有 nativeSessionRef，不抛 RUNTIME_SESSION_UNAVAILABLE）
		const stream = await env.host.streamEventsV3(
			eventsRequest,
			verifyRuntimeV2Fixture(eventsRequest.grant),
		);
		const iterator = stream[Symbol.asyncIterator]();
		// 应能读到事件（Driver 处理中）
		const { done } = await iterator.next();
		await iterator.return?.(undefined);
		// 正常流（不是 RUNTIME_SESSION_UNAVAILABLE 错误）
		expect(done).toBe(false);

		await env.host.close();
	});
});
