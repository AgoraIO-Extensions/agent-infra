import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const CODEX_SESSION_EXECUTOR_ENDPOINT = "ws://127.0.0.1:8068";
export const CODEX_SESSION_EXECUTOR_BACKEND = "ws://127.0.0.1:8070";
export const CODEX_SESSION_EXECUTOR_STATUS = "http://127.0.0.1:8068/status";
export const CODEX_SESSION_EXECUTOR_BINDING_ENV =
	"AGENT_INFRA_CODEX_SESSION_EXECUTOR_BINDING";
export const CODEX_SESSION_EXECUTOR_ATTESTATION_ENV =
	"AGENT_INFRA_CODEX_SESSION_EXECUTOR_ATTESTATION";
const id = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[\x21-\x7e]+$/);
const revision = z.number().int().positive().safe();
const bindingSchema = z.strictObject({
	schemaVersion: z.literal(1),
	namespace: z.string().regex(/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/),
	podName: z
		.string()
		.regex(/^sandbox-[a-z0-9-]+$/)
		.max(253),
	agentId: id,
	conversationId: id,
	sessionGeneration: revision,
	sandboxId: id,
	resourceFence: revision,
	imageDigest: z.string().regex(/^[a-z0-9][a-z0-9.:/-]*@sha256:[a-f0-9]{64}$/),
	conversationKey: z.string().regex(/^[a-f0-9]{64}$/),
	workspaceRoot: z.string(),
	workspaceSubPath: z.string(),
});
export type CodexSessionExecutorBindingV1 = z.infer<typeof bindingSchema>;

function invalid(): never {
	throw new Error("CODEX_SESSION_EXECUTOR_INVALID");
}

type BindingIdentity = Omit<
	CodexSessionExecutorBindingV1,
	"schemaVersion" | "conversationKey" | "workspaceRoot" | "workspaceSubPath"
>;

export function createCodexSessionExecutorBindingV1(
	input: BindingIdentity,
): CodexSessionExecutorBindingV1 {
	const conversationKey = createHash("sha256")
		.update(
			JSON.stringify([
				input.agentId,
				input.conversationId,
				input.sessionGeneration,
			]),
		)
		.digest("hex");
	const workspaceSubPath = `runtime/codex-driver.json.native/conversations/${conversationKey}/workspace`;
	return bindingSchema.parse({
		...input,
		schemaVersion: 1,
		conversationKey,
		workspaceRoot: `/workspace/${workspaceSubPath}`,
		workspaceSubPath,
	});
}

export function parseCodexSessionExecutorBindingV1(
	input: unknown,
): CodexSessionExecutorBindingV1 {
	try {
		const binding = bindingSchema.parse(input);
		const expected = createCodexSessionExecutorBindingV1(binding);
		if (
			binding.conversationKey !== expected.conversationKey ||
			binding.workspaceRoot !== expected.workspaceRoot ||
			binding.workspaceSubPath !== expected.workspaceSubPath ||
			binding.podName !== `sandbox-${binding.sandboxId}`
		)
			invalid();
		return binding;
	} catch {
		return invalid();
	}
}

export function codexSessionExecutorBindingDigestV1(input: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(parseCodexSessionExecutorBindingV1(input)))
		.digest("hex");
}

export function codexSessionExecutorAttestationV1(
	input: unknown,
	serviceToken: string,
): string {
	if (!/^[\x21-\x7e]{16,8192}$/.test(serviceToken)) invalid();
	return createHmac("sha256", serviceToken)
		.update(
			`codex-session-executor-v1\0${JSON.stringify(parseCodexSessionExecutorBindingV1(input))}`,
		)
		.digest("base64url");
}

export function verifyCodexSessionExecutorBindingV1(
	input: unknown,
	attestation: string,
	serviceToken: string,
): CodexSessionExecutorBindingV1 {
	const binding = parseCodexSessionExecutorBindingV1(input);
	const expected = codexSessionExecutorAttestationV1(binding, serviceToken);
	if (
		!/^[A-Za-z0-9_-]{43}$/.test(attestation) ||
		!timingSafeEqual(Buffer.from(expected), Buffer.from(attestation))
	)
		invalid();
	return binding;
}
