import assert from "node:assert/strict";
import test from "node:test";

import { cidr } from "../deploy/local/native-metadata-proxy.mjs";

test("native metadata proxy normalizes high-bit CIDR networks", () => {
	assert.deepEqual(cidr("192.168.65.0/24"), {
		network: 3232252160,
		mask: 4294967040,
	});
});

test("native metadata proxy rejects malformed CIDR input", () => {
	assert.equal(cidr("192.168.65.0/33"), null);
	assert.equal(cidr("not-an-ip/24"), null);
});
