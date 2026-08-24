import { createConnectionApp } from "./app";

export const connectionApiService = "connection-api";

export function createProductionConnectionApp() {
	// HLD G-01 is open. The production image may report health, but cannot
	// publish identity, OAuth, MCP, or Provider routes before conformance approval.
	return createConnectionApp();
}
