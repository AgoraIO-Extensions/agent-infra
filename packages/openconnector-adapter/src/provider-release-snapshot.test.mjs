import test from "node:test";
import { verifyReleaseSnapshot } from "../scripts/provider-release-snapshot.mjs";

test("release snapshot represents the exact catalogs used by runtime publication", () => {
	verifyReleaseSnapshot();
});
