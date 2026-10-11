import { registerHooks } from "node:module";

// Frozen v2 tests asserted their then-current catalog. Bind only that archived
// test import to its version-specific view; production imports remain current.
const archivedTest = new URL(
	"../src/providers/static-spaces/versions/static-spaces-v2.test.ts",
	import.meta.url,
).href;
const view = new URL("../src/static-spaces-v2-test-project.ts", import.meta.url)
	.href;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (
			(context.parentURL === archivedTest ||
				context.parentURL ===
					new URL(
						"../src/providers/static-spaces/versions/static-spaces-v3.test.ts",
						import.meta.url,
					).href) &&
			specifier === "../../../provider-catalogs.ts"
		)
			return {
				url:
					context.parentURL === archivedTest
						? view
						: new URL(
								"../src/static-spaces-v3-test-project.ts",
								import.meta.url,
							).href,
				shortCircuit: true,
			};
		return nextResolve(specifier, context);
	},
});
