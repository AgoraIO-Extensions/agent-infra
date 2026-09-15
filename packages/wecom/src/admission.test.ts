import { expect, it } from "vitest";
import { createWecomChannelAdmissionV1 } from "./admission.ts";

it("admits only the deployment-allocated configuration for this Agent and preserves untouched bindings", async () => {
	const admission = createWecomChannelAdmissionV1(async (reference) =>
		reference === "approved"
			? {
					agentId: "agent-1",
					bindingReference: reference,
					kind: "wecom_bot",
					botId: "bot-1",
					token: "fixture",
					encodingAesKey: Buffer.alloc(32, 7).toString("base64").slice(0, 43),
					credentialVersion: "v1",
				}
			: null,
	);
	const input = {
		schemaVersion: 1 as const,
		agentId: "agent-1",
		requestId: "request-1",
		traceId: "trace-1",
		current: [{ kind: "wecom_app" as const, bindingReference: "existing-app" }],
		requested: [
			{
				kind: "wecom_bot" as const,
				enabled: true as const,
				bindingReference: "approved",
			},
		],
	};
	expect(await admission.admitChannels(input)).toMatchObject({
		status: "admitted",
		channels: [
			{ kind: "wecom_app", bindingReference: "existing-app" },
			{ kind: "wecom_bot", bindingReference: "approved" },
		],
	});
	expect(
		await admission.admitChannels({ ...input, agentId: "other" }),
	).toMatchObject({ status: "rejected" });
	expect(
		await admission.admitChannels({
			...input,
			requested: [
				{ kind: "wecom_bot", enabled: true, bindingReference: "unknown" },
			],
		}),
	).toMatchObject({ status: "rejected" });
});
