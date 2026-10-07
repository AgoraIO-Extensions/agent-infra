import type {
	FileAccessGrantV1,
	FileDescriptorV1,
} from "@agent-infra/contracts/files";
import type { ExecutionGrantClaimsV1 } from "@agent-infra/contracts/pilot";
import type { createWorkerFileClientV1 } from "./file-client.js";

export type BrowserFileExecutionBindingV1 = Readonly<{
	agentId: string;
	conversationId: string;
	executionId: string;
	sessionGeneration: number;
}>;

type BrowserFileBindingInputV1 = Readonly<{
	binding: BrowserFileExecutionBindingV1;
	executionGrant: FileAccessGrantV1;
}>;

type BrowserFileExecutionClaimsV1 = Pick<
	ExecutionGrantClaimsV1,
	"agentId" | "conversationId" | "executionId" | "sessionGeneration"
>;

type WorkerFileClientV1 = ReturnType<typeof createWorkerFileClientV1>;
type BrowserFileResultV1 = Awaited<
	ReturnType<WorkerFileClientV1["writeResult"]>
>;

function assertBinding(binding: BrowserFileExecutionBindingV1): void {
	if (
		!binding ||
		!["agentId", "conversationId", "executionId"].every(
			(key) =>
				typeof binding[key as keyof BrowserFileExecutionBindingV1] ===
					"string" &&
				(binding[key as keyof BrowserFileExecutionBindingV1] as string).length >
					0,
		) ||
		!Number.isSafeInteger(binding.sessionGeneration) ||
		binding.sessionGeneration < 1
	)
		throw new Error("BROWSER_FILE_BINDING_INVALID");
}

function sameBinding(
	left: BrowserFileExecutionBindingV1,
	right: BrowserFileExecutionBindingV1,
): boolean {
	return (
		left.agentId === right.agentId &&
		left.conversationId === right.conversationId &&
		left.executionId === right.executionId &&
		left.sessionGeneration === right.sessionGeneration
	);
}

function assertSameBinding(
	expected: BrowserFileExecutionBindingV1,
	actual: BrowserFileExecutionBindingV1,
): void {
	assertBinding(actual);
	if (!sameBinding(expected, actual))
		throw new Error("BROWSER_FILE_BINDING_CONFLICT");
}

/**
 * Browser's narrow consumer seam over the existing execution-bound File Grant
 * client. It carries binding facts alongside every transfer and delegates all
 * authorization, storage, limits and completion semantics to File Core.
 */
export function createBrowserFileGrantBridgeV1(input: {
	readonly client: Pick<WorkerFileClientV1, "readInput" | "writeResult">;
	readonly binding: BrowserFileExecutionBindingV1;
	readonly verifyExecutionGrant: (
		grant: FileAccessGrantV1,
	) => Promise<BrowserFileExecutionClaimsV1>;
}) {
	assertBinding(input.binding);
	if (typeof input.verifyExecutionGrant !== "function")
		throw new Error("BROWSER_FILE_GRANT_VERIFIER_REQUIRED");
	const binding = Object.freeze({ ...input.binding });

	async function verify(input_: BrowserFileBindingInputV1): Promise<void> {
		assertSameBinding(binding, input_.binding);
		const claims = await input.verifyExecutionGrant(input_.executionGrant);
		if (
			claims.agentId !== binding.agentId ||
			claims.conversationId !== binding.conversationId ||
			claims.executionId !== binding.executionId ||
			claims.sessionGeneration !== binding.sessionGeneration
		)
			throw new Error("BROWSER_FILE_GRANT_BINDING_CONFLICT");
	}

	return {
		binding,
		async readInput(
			input_: BrowserFileBindingInputV1 & {
				readonly fileId: string;
				readonly idempotencyKey: string;
			},
		) {
			await verify(input_);
			return await input.client.readInput(
				input_.executionGrant,
				input_.fileId,
				input_.idempotencyKey,
			);
		},
		async writeResult(
			input_: BrowserFileBindingInputV1 & {
				readonly descriptor: FileDescriptorV1;
				readonly body: ReadableStream<Uint8Array>;
				readonly idempotencyKey: string;
				readonly accessIdempotencyKey?: string;
			},
		): Promise<BrowserFileResultV1> {
			await verify(input_);
			return await input.client.writeResult(
				input_.executionGrant,
				input_.descriptor,
				input_.body,
				input_.idempotencyKey,
				input_.accessIdempotencyKey,
			);
		},
	};
}

export type BrowserFileGrantBridgeV1 = ReturnType<
	typeof createBrowserFileGrantBridgeV1
>;

export type BrowserFileGrantClientV1 = ReturnType<
	typeof createWorkerFileClientV1
>;
