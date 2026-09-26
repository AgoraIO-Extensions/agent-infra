import { appendFileSync, readFileSync } from "node:fs";

// The test runs the actual CLI with this bounded gh replay executable.
const fixture = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8"));
const args = process.argv.slice(4);
appendFileSync(process.argv[3] ?? "", `${JSON.stringify(args)}\n`);
if (fixture.malformed) {
	console.log("MUST_NOT_LEAK invalid private response");
	process.exit(0);
}
if (fixture.fail === args.slice(0, 2).join(" ")) {
	console.error("private credential MUST_NOT_LEAK");
	process.exit(1);
}
if (args[0] === "repo" && args[1] === "view") {
	console.log(JSON.stringify(fixture.repository));
} else if (args[0] === "api" && args[1] === "graphql") {
	console.log(
		JSON.stringify({ data: { repository: { issue: fixture.issue } } }),
	);
} else if (args[0] === "api" && args.includes("--paginate")) {
	console.log(JSON.stringify([fixture.dependencies]));
} else if (args[0] === "pr" && args[1] === "list") {
	console.log(JSON.stringify([{ number: 698, body: "Closes #691" }]));
} else if (args[0] === "pr" && args[1] === "view" && args[2] === "698") {
	console.log(JSON.stringify(fixture.pr));
} else {
	throw new Error(
		"unexpected gh call: replay allows only bounded read operations",
	);
}
