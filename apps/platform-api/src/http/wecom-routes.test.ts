import {
	createWecomAdapterV1,
	type WecomConfigurationV1,
} from "@agent-infra/wecom";
import { wecomCallbackFixtureV1 } from "@agent-infra/wecom/testing";
import { expect, it } from "vitest";
import { createPlatformHealthApp } from "../app.ts";
import { registerWecomRoutesV1 } from "./wecom-routes.ts";

const config: WecomConfigurationV1 = {
	agentId: "agent",
	bindingReference: "binding",
	kind: "wecom_bot",
	botId: "bot",
	token: "fixture",
	encodingAesKey: Buffer.alloc(32, 7).toString("base64").slice(0, 43),
	credentialVersion: "v1",
};
const message = {
	msgid: "event",
	aibotid: "bot",
	chattype: "group",
	chatid: "group",
	from: { userid: "sender" },
	msgtype: "text",
	text: { content: "private fixture content" },
	response_url:
		"https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=fixture",
};
function fixture(
	outcome: "accepted" | "denied",
	protectReply: () => Promise<string> = async () => "protected",
) {
	const app = createPlatformHealthApp();
	const seen: unknown[] = [];
	const observed: string[] = [];
	const now = new Date();
	registerWecomRoutesV1(app, {
		resolveBinding: async () => config,
		adapter: createWecomAdapterV1({
			now: () => now,
			protectReply,
		}),
		channel: {
			async receive(input) {
				seen.push(input);
				return outcome === "denied"
					? { outcome }
					: {
							outcome,
							receipt: {
								receiptId: "receipt",
								status: "accepted",
								conversationId: "conversation",
								executionId: "execution",
							},
						};
			},
		},
		receipts: {
			async read() {
				return null;
			},
			async list() {
				return { items: [], nextCursor: null };
			},
			async abandon() {
				return false;
			},
		},
		observe: (result) => observed.push(result),
	});
	return {
		app,
		seen,
		observed,
		request: () => wecomCallbackFixtureV1(config, message, now),
	};
}
it("returns 503 when durable reply protection is unavailable", async () => {
	const f = fixture("accepted", async () => {
		throw new Error("reply store unavailable");
	});
	const response = await f.app.request(f.request());
	expect(response.status).toBe(503);
	expect(f.seen).toHaveLength(0);
	expect(f.observed).toEqual(["unavailable"]);
});
it("only hands a verified callback to Core and acknowledges saved acceptance", async () => {
	const f = fixture("accepted");
	const response = await f.app.request(f.request());
	expect(response.status).toBe(200);
	expect(await response.text()).toBe("");
	expect(f.seen).toHaveLength(1);
	expect(f.observed).toEqual(["accepted"]);
	expect(JSON.stringify(f.observed)).not.toContain("private fixture");
});
it("returns an encrypted permission denial and rejects unsigned requests without invoking Core", async () => {
	const f = fixture("denied");
	const response = await f.app.request(f.request());
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		encrypt: expect.any(String),
		msgsignature: expect.any(String),
	});
	const invalid = await f.app.request("/callbacks/wecom/binding", {
		method: "POST",
		body: "{}",
	});
	expect(invalid.status).toBe(400);
	expect(f.seen).toHaveLength(1);
	expect(f.observed).toEqual(["denied", "invalid"]);
});
