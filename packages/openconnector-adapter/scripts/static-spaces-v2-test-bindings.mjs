import { registerHooks } from "node:module";

// Bind only archived tests to their then-current catalog; production imports remain current.
const views = new Map(
	[2, 3, 4, 5].map((version) => [
		new URL(
			`../src/providers/static-spaces/versions/static-spaces-v${version}.test.ts`,
			import.meta.url,
		).href,
		new URL(`../src/static-spaces-v${version}-test-project.ts`, import.meta.url)
			.href,
	]),
);
registerHooks({
	resolve(specifier, context, nextResolve) {
		const view = views.get(context.parentURL);
		if (view && specifier === "../../../provider-catalogs.ts")
			return { url: view, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
