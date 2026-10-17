import assert from "node:assert/strict";
import test from "node:test";

import { cidr, isAllowedSource } from "./native-metadata-proxy.mjs";

const composeNetwork = cidr("172.22.0.0/16");

test("allows the Docker bridge source", () => {
	assert.equal(
		isAllowedSource("172.22.0.4", composeNetwork, "192.168.31.32"),
		true,
	);
});

test("allows the host bind address used by Colima NAT", () => {
	assert.equal(
		isAllowedSource("192.168.31.32", composeNetwork, "192.168.31.32"),
		true,
	);
});

test("rejects an unrelated private source", () => {
	assert.equal(
		isAllowedSource("192.168.31.33", composeNetwork, "192.168.31.32"),
		false,
	);
});

test("rejects IPv6 and malformed addresses", () => {
	assert.equal(
		isAllowedSource("::ffff:192.168.31.32", composeNetwork, "192.168.31.32"),
		false,
	);
	assert.equal(isAllowedSource("::1", composeNetwork, "192.168.31.32"), false);
	assert.equal(
		isAllowedSource("not-an-ip", composeNetwork, "192.168.31.32"),
		false,
	);
});
