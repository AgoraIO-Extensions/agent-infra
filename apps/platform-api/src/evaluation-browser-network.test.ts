import { describe, expect, test } from "vitest";
import {
	isLocalDockerEndpoint,
	isLocalLinuxDockerEndpoint,
	ownedInterfaceNetworkReady,
} from "./evaluation-browser-network.js";

const ready = {
	up: true,
	disableIpv6: false,
	linkLocal: [{}],
	procFlags: [0x80],
};

describe("owned fixture interface readiness", () => {
	test("only treats Unix Docker endpoints as local", () => {
		expect(isLocalDockerEndpoint("unix:///var/run/docker.sock")).toBe(true);
		expect(isLocalDockerEndpoint("ssh://docker@example")).toBe(false);
		expect(isLocalDockerEndpoint("tcp://docker.example:2376")).toBe(false);
		expect(
			isLocalLinuxDockerEndpoint("darwin", "unix:///var/run/docker.sock"),
		).toBe(false);
		expect(isLocalLinuxDockerEndpoint("linux", "ssh://docker@example")).toBe(
			false,
		);
		expect(
			isLocalLinuxDockerEndpoint("linux", "unix:///var/run/docker.sock"),
		).toBe(true);
	});

	test("requires a link-local address", () => {
		expect(ownedInterfaceNetworkReady({ ...ready, linkLocal: [] })).toBe(false);
	});

	test("rejects tentative or DAD-failed addresses", () => {
		expect(
			ownedInterfaceNetworkReady({
				...ready,
				linkLocal: [{ tentative: true }],
			}),
		).toBe(false);
		expect(ownedInterfaceNetworkReady({ ...ready, procFlags: [0x08] })).toBe(
			false,
		);
	});

	test("accepts a verified address or explicit IPv6 disablement", () => {
		expect(ownedInterfaceNetworkReady(ready)).toBe(true);
		expect(
			ownedInterfaceNetworkReady({
				...ready,
				disableIpv6: true,
				linkLocal: [],
				procFlags: [],
			}),
		).toBe(true);
	});
});
