import assert from "node:assert/strict";
import test from "node:test";

import {
	imageNames,
	selectedImageNames,
} from "../deploy/release/ci-image-build.mjs";

test("image build defaults to every deployment image", () => {
	assert.deepEqual(selectedImageNames(), imageNames);
});

test("image build accepts a unique selected image list", () => {
	assert.deepEqual(selectedImageNames("--images=web,agent-runtime-host"), [
		"web",
		"agent-runtime-host",
	]);
});

test("image build rejects empty, duplicate, and unknown selections", () => {
	for (const value of ["--images=", "--images=web,web", "--images=missing"]) {
		assert.throws(() => selectedImageNames(value), /image selection/);
	}
});
