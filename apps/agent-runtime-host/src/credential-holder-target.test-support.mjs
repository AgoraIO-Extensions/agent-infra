// Target process for credential-holder-attack.test.ts. Run with Node type
// stripping; it imports the production module, not a copy.
import {
	protectCredentialHolderProcessV1,
	readProcessDumpableV1,
} from "./credential-holder-protection.ts";

if (process.argv[2] === "protect" && !protectCredentialHolderProcessV1())
	process.exit(3);
process.stdout.write(`ready ${process.pid} ${readProcessDumpableV1()}\n`);
setInterval(() => {}, 1000);
