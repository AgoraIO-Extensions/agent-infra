import { describe, expect, it } from "vitest";
import { immutableImagePullPolicyMatches } from "./immutable-image-pull-policy.js";

describe("immutable image pull policy", () => {
	const image = `registry.example.test/runtime@sha256:${"a".repeat(64)}`;
	const expected = { image, imagePullPolicy: "IfNotPresent" };
	it("accepts identical policy and the stricter local-only policy for the same digest", () => {
		expect(immutableImagePullPolicyMatches(expected, expected)).toBe(true);
		expect(
			immutableImagePullPolicyMatches(
				{ ...expected, imagePullPolicy: "Never" },
				expected,
			),
		).toBe(true);
	});
	it("rejects changed images, mutable tags, relaxed policy and unapproved defaults", () => {
		for (const actual of [
			{
				...expected,
				image: image.replace("runtime", "other"),
				imagePullPolicy: "Never",
			},
			{ ...expected, imagePullPolicy: "Always" },
			{ image },
		]) {
			expect(immutableImagePullPolicyMatches(actual, expected)).toBe(false);
		}
		expect(
			immutableImagePullPolicyMatches(
				{
					image: "registry.example.test/runtime:latest",
					imagePullPolicy: "Never",
				},
				{
					image: "registry.example.test/runtime:latest",
					imagePullPolicy: "IfNotPresent",
				},
			),
		).toBe(false);
	});
});
