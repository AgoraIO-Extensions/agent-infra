import { expect, it } from "vitest";
import { validateWecomBotQrConfigurationV1 } from "./wecom-setup-assembly.js";

it("normalizes only same-origin HTTPS QR deployment configuration", () => {
	expect(
		validateWecomBotQrConfigurationV1({
			source: "agent-infra",
			authOrigin: "https://auth.example.test/",
			authorizationEndpoint: "https://auth.example.test/authorize?fixed=1",
		}),
	).toEqual({
		source: "agent-infra",
		authOrigin: "https://auth.example.test",
		authorizationEndpoint: "https://auth.example.test/authorize?fixed=1",
	});
});

it.each([
	[
		"http origin",
		{
			source: "agent-infra",
			authOrigin: "http://auth.example.test",
			authorizationEndpoint: "https://auth.example.test/authorize",
		},
	],
	[
		"foreign endpoint",
		{
			source: "agent-infra",
			authOrigin: "https://auth.example.test",
			authorizationEndpoint: "https://other.example.test/authorize",
		},
	],
	[
		"invalid source",
		{
			source: "agent infra",
			authOrigin: "https://auth.example.test",
			authorizationEndpoint: "https://auth.example.test/authorize",
		},
	],
] as const)("rejects %s", (_name, value) => {
	expect(() => validateWecomBotQrConfigurationV1(value)).toThrow(
		/Invalid WeCom QR/,
	);
});
