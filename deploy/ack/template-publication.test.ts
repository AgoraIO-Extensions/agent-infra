import { expect, it } from "vitest";
import { runTemplatePublicationOperatorV1 } from "./template-publication.ts";

const result = {
	schemaVersion: 1,
	publicationId: "release-test",
	status: "active",
	counts: { applied: 0, pending: 0, unknown: 0, rejected: 0 },
	targets: [],
	nextCursor: null,
};
it("uses the administrator only to prepare and the authenticated service only to activate the fixed publication", async () => {
	const requests: { actor: string; request: Request }[] = [];
	const input = {
		publicationId: "release-test",
		origin: "https://publication.test",
		administratorRequest: async (request: Request) => {
			requests.push({ actor: "administrator", request });
			return Response.json(result, { status: 202 });
		},
		serviceRequest: async (request: Request) => {
			requests.push({ actor: "service", request });
			return Response.json(result, { status: 202 });
		},
	};
	await runTemplatePublicationOperatorV1("prepare", input);
	await runTemplatePublicationOperatorV1("activate", input);
	expect(requests.map((r) => r.actor)).toEqual(["administrator", "service"]);
	expect(await requests[0]!.request.json()).toEqual({ schemaVersion: 1 });
	expect(requests[1]!.request.url).toBe(
		"https://publication.test/internal/ops/standard-template-releases/release-test/activate-automatic",
	);
});
it("returns a fixed error without carrying private transport messages or causes", async () => {
	const request = async () => {
		throw new Error("synthetic-private-credential-canary");
	};
	const error = await runTemplatePublicationOperatorV1("prepare", {
		publicationId: "release-test",
		origin: "https://publication.test",
		administratorRequest: request,
		serviceRequest: request,
	}).catch((error: unknown) => error);
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).toBe(
		"TEMPLATE_PUBLICATION_OPERATOR_UNAVAILABLE",
	);
	expect(Object.hasOwn(error as object, "cause")).toBe(false);
});

it("uses the named administrator transport to register and verifies the returned Agent", async () => {
	const response = {
		schemaVersion: 1,
		releaseId: "release-test",
		agentId: "agent-test",
		state: "registered",
		operatorId: "operator",
		templateId: "codex",
		expectedConfigurationRevision: 2,
		expectedImageDigest: "sha256:" + "a".repeat(64),
		targetImageDigest: "sha256:" + "b".repeat(64),
		installation: "test-install",
		clusterUid: "cluster",
		namespace: "test",
		namespaceUid: "namespace",
		sourceCommit: "f".repeat(40),
		expiresAt: null,
	};
	const input = {
		publicationId: "release-test",
		agentId: "agent-test",
		origin: "https://publication.test",
		serviceRequest: async () => {
			throw new Error("unexpected service");
		},
		administratorRequest: async (request: Request) => {
			expect(request.method).toBe("POST");
			expect(request.headers.get("Idempotency-Key")).toBe("release-test");
			expect(await request.json()).toEqual({ schemaVersion: 1 });
			return Response.json(response, {
				status: new URL(request.url).pathname.endsWith("/registration")
					? 200
					: 202,
			});
		},
	};
	expect(await runTemplatePublicationOperatorV1("register", input)).toEqual(
		response,
	);
	expect(await runTemplatePublicationOperatorV1("registration", input)).toEqual(
		response,
	);
	await expect(
		runTemplatePublicationOperatorV1("register", {
			...input,
			agentId: "other",
		}),
	).rejects.toThrow("TEMPLATE_PUBLICATION_OPERATOR_UNAVAILABLE");
});

const applied = {
	schemaVersion: 1,
	agentId: "agent-test",
	configurationRevision: 4,
	changedFields: ["source"],
};
const scopedOperator = {
	publicationId: "release-test",
	agentId: applied.agentId,
	expectedConfigurationRevision: 3,
	origin: "https://publication.test",
	serviceRequest: async () => {
		throw new Error("unexpected service transport");
	},
};

it("reads the original single-Agent result after a lost apply response", async () => {
	const requests: Request[] = [];
	const operator = {
		...scopedOperator,
		administratorRequest: async (request: Request) => {
			requests.push(request);
			if (new URL(request.url).pathname.endsWith("/apply"))
				throw new Error("response lost");
			return Response.json(applied);
		},
	};
	await expect(
		runTemplatePublicationOperatorV1("apply", operator),
	).rejects.toThrow();
	await expect(
		runTemplatePublicationOperatorV1("result", operator),
	).resolves.toEqual(applied);
	expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
		"/internal/ops/standard-template-releases/release-test/apply",
		"/internal/ops/standard-template-releases/release-test/result",
	]);
	for (const request of requests) {
		expect(request.method).toBe("POST");
		expect(request.headers.get("Idempotency-Key")).toBe("release-test");
		expect(await request.text()).toBe('{"schemaVersion":1}');
	}
});

it("accepts only the selected Agent and its next configuration revision", async () => {
	const operator = {
		...scopedOperator,
		administratorRequest: async () => Response.json(applied, { status: 202 }),
	};
	await expect(
		runTemplatePublicationOperatorV1("apply", operator),
	).resolves.toEqual(applied);
	for (const wrong of [
		{ agentId: "other-agent" },
		{ configurationRevision: 9 },
	]) {
		await expect(
			runTemplatePublicationOperatorV1("result", {
				...operator,
				administratorRequest: async () =>
					Response.json({ ...applied, ...wrong }),
			}),
		).rejects.toThrow("TEMPLATE_PUBLICATION_OPERATOR_UNAVAILABLE");
	}
});

it("leaves a missing result open and never submits while reading it", async () => {
	const paths: string[] = [];
	const administratorRequest = async (request: Request) => {
		paths.push(new URL(request.url).pathname);
		return new Response(null, { status: 404 });
	};
	await expect(
		runTemplatePublicationOperatorV1("result", {
			...scopedOperator,
			administratorRequest,
		}),
	).rejects.toThrow("TEMPLATE_PUBLICATION_OPERATOR_UNAVAILABLE");
	for (const missing of [
		{ agentId: undefined },
		{ expectedConfigurationRevision: undefined },
		{ expectedConfigurationRevision: 0 },
		{ publicationId: ".." },
	]) {
		await expect(
			runTemplatePublicationOperatorV1("apply", {
				...scopedOperator,
				...missing,
				administratorRequest,
			}),
		).rejects.toThrow("TEMPLATE_PUBLICATION_OPERATOR_UNAVAILABLE");
	}
	expect(paths).toEqual([
		"/internal/ops/standard-template-releases/release-test/result",
	]);
});
