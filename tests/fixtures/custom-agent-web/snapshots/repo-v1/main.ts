import { compute, dependencyVersion } from "../env/dependency.ts";

const input = Number(process.argv[2]);
process.stdout.write(
	JSON.stringify({
		schemaVersion: 1,
		input,
		repoVersion: 1,
		dependencyVersion,
		total: compute(input),
	}),
);
