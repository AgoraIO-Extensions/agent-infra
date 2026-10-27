import { describe, expect, it, vi } from "vitest";
import {
	applicationFoundationActorContextV1,
	applicationFoundationAdmissionDependenciesV1,
} from "./application-foundation.conformance.js";
import { createApplicationModelCandidatesUseCaseV1 } from "./application-foundation.js";

const input = {
	agentId: "preview-agent",
	requestId: "preview-request",
	traceId: "preview-trace",
	templateId: "template_01",
	defaultRelayKey: "synthetic-preview-key",
};
function fixture() {
	const base = applicationFoundationAdmissionDependenciesV1();
	const authorize = vi.fn(base.authorizationAdmission.authorize);
	const image = vi.fn(base.imageAdmission.admitImage);
	const candidates = vi.fn().mockResolvedValue([
		{
			endpointId: "relay",
			modelId: "new-model",
			reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
		},
	]);
	const preview = createApplicationModelCandidatesUseCaseV1({
		authorizationAdmission: { authorize },
		imageAdmission: { admitImage: image },
		defaultRelayKey: {
			candidates,
			verify: vi.fn(),
			encrypt: vi.fn(),
			currentIdentity: vi.fn(),
		},
	});
	return { authorize, image, candidates, preview };
}
describe("application model candidates", () => {
	it("uses the admitted template and rechecks current authority after reading candidates", async () => {
		const f = fixture();
		const result = await f.preview(input, applicationFoundationActorContextV1);
		expect(result.candidates).toEqual(
			await f.candidates.mock.results[0]?.value,
		);
		expect(f.authorize).toHaveBeenCalledTimes(2);
		expect(f.candidates).toHaveBeenCalledWith(input.defaultRelayKey, {
			source: expect.objectContaining({
				kind: "standard",
				templateId: input.templateId,
			}),
		});
	});
	it("rejects a changed authority revision after candidate I/O", async () => {
		const f = fixture();
		const original =
			applicationFoundationAdmissionDependenciesV1().authorizationAdmission
				.authorize;
		let reads = 0;
		f.authorize.mockImplementation(async (args) => ({
			...(await original(args)),
			authorizationRevision: ++reads === 1 ? "initial" : "changed",
		}));
		await expect(
			f.preview(input, applicationFoundationActorContextV1),
		).rejects.toMatchObject({ code: "not_authorized" });
	});
	it("rejects another template before reading the Key models", async () => {
		const f = fixture();
		await expect(
			f.preview(
				{ ...input, templateId: "other-template" },
				applicationFoundationActorContextV1,
			),
		).rejects.toMatchObject({ code: "not_admitted" });
		expect(f.candidates).not.toHaveBeenCalled();
	});
	it("rejects unexpected identity overrides and unavailable image admission", async () => {
		const f = fixture();
		await expect(
			f.preview(
				{ ...input, userId: "another-user" } as typeof input,
				applicationFoundationActorContextV1,
			),
		).rejects.toBeDefined();
		expect(f.candidates).not.toHaveBeenCalled();
		f.image.mockRejectedValueOnce(new Error(input.defaultRelayKey));
		await expect(
			f.preview(input, applicationFoundationActorContextV1),
		).rejects.toMatchObject({ code: "dependency_unavailable" });
	});
});
