import { describe, expect, it } from "vitest";
import { pilotBrowserOpenApiPathsV1 } from "./browser.ts";
import {
	WecomBotConnectionProjectionV2Schema,
	wecomBotConnectionOpenApiPathsV2,
} from "./wecom-bot-connection.ts";

const v1Status =
	pilotBrowserOpenApiPathsV1["/api/v1/agents/{agentId}/wecom-bot"].get
		.responses["200"].content["application/json"].schema;
const begin =
	pilotBrowserOpenApiPathsV1["/api/v1/agents/{agentId}/wecom-setup"].post
		.responses["200"].content["application/json"].schema;

describe("WeCom bot status V2 with QR availability (#2911)", () => {
	it("accepts only the two availability branches", () => {
		for (const status of [
			"not_configured",
			"callback",
			"verifying",
			"connected",
			"disconnected",
			"auth_failed",
		])
			expect(
				WecomBotConnectionProjectionV2Schema.safeParse({
					status,
					qrAvailable: true,
				}).success,
			).toBe(true);
		expect(
			WecomBotConnectionProjectionV2Schema.parse({
				status: "connected",
				qrAvailable: false,
				qrUnavailableReason: "authorization_correlation_unverified",
			}),
		).toEqual({
			status: "connected",
			qrAvailable: false,
			qrUnavailableReason: "authorization_correlation_unverified",
		});
	});

	it.each([
		["the V1 status-only shape", { status: "connected" }],
		[
			"an unavailable result without a reason",
			{ status: "connected", qrAvailable: false },
		],
		[
			"an unknown reason",
			{ status: "connected", qrAvailable: false, qrUnavailableReason: "x" },
		],
		[
			"a reason on an available result",
			{
				status: "connected",
				qrAvailable: true,
				qrUnavailableReason: "authorization_correlation_unverified",
			},
		],
		[
			"authorization material that only the setup session may carry",
			{
				status: "not_configured",
				qrAvailable: true,
				qr: {
					authorizationUrl: "https://auth.example.test/authorize",
					authOrigin: "https://auth.example.test",
					source: "agent-infra",
					state: "one-time-state",
				},
			},
		],
		[
			"a request-supplied identity field",
			{ status: "connected", qrAvailable: true, actorId: "owner" },
		],
		["an unknown status", { status: "unknown", qrAvailable: true }],
	])("rejects %s", (_name, value) => {
		expect(WecomBotConnectionProjectionV2Schema.safeParse(value).success).toBe(
			false,
		);
	});

	it("keeps the published V1 status response strict and status-only", () => {
		expect(v1Status.safeParse({ status: "connected" }).success).toBe(true);
		expect(
			v1Status.safeParse({ status: "connected", qrAvailable: true }).success,
		).toBe(false);
		expect(
			v1Status.safeParse({
				status: "connected",
				qrAvailable: false,
				qrUnavailableReason: "authorization_correlation_unverified",
			}).success,
		).toBe(false);
	});

	it("reuses the setup session's unavailable reason value", () => {
		const setup = {
			sessionId: "setup",
			agentId: "agent",
			configurationRevision: 1,
			expiresAt: "2026-10-20T00:00:00Z",
			status: "awaiting_input",
			state: "one-time-state",
			qrAvailable: false,
			qrUnavailableReason: "authorization_correlation_unverified",
		} as const;
		expect(begin.safeParse(setup).success).toBe(true);
		expect(
			WecomBotConnectionProjectionV2Schema.safeParse({
				status: "not_configured",
				qrAvailable: setup.qrAvailable,
				qrUnavailableReason: setup.qrUnavailableReason,
			}).success,
		).toBe(true);
	});

	it("publishes a single V2 read entry", () => {
		expect(Object.keys(wecomBotConnectionOpenApiPathsV2)).toEqual([
			"/api/v2/agents/{agentId}/wecom-bot",
		]);
		const operation =
			wecomBotConnectionOpenApiPathsV2["/api/v2/agents/{agentId}/wecom-bot"]
				.get;
		expect(operation.operationId).toBe("getWecomBotConnectionV2");
		expect(Object.keys(operation.responses).sort()).toEqual([
			"200",
			"401",
			"403",
			"404",
			"500",
			"503",
		]);
	});
});
