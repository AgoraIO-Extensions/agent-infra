import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";

export type CodexBrowserToolOperationV1 =
	| "navigate"
	| "observe"
	| "interact"
	| "files"
	| "handoff"
	| "side_effects";

export type CodexBrowserToolDescriptorV1 = Readonly<{
	name: `browser_${CodexBrowserToolOperationV1}`;
	description: string;
	operation: CodexBrowserToolOperationV1;
	capabilityVersion: number;
	inputSchema: Readonly<Record<string, unknown>>;
}>;

const pageReferenceProperties = {
	pageId: { type: "string", minLength: 1, maxLength: 256 },
	pageRevision: { type: "integer", minimum: 1 },
} as const;

const schemas: Record<
	CodexBrowserToolOperationV1,
	Readonly<Record<string, unknown>>
> = {
	navigate: {
		type: "object",
		additionalProperties: false,
		properties: { url: { type: "string", minLength: 1, maxLength: 2048 } },
		required: ["url"],
	},
	observe: {
		type: "object",
		additionalProperties: false,
		properties: pageReferenceProperties,
		required: ["pageId", "pageRevision"],
	},
	interact: {
		type: "object",
		additionalProperties: false,
		properties: {
			...pageReferenceProperties,
			elementId: { type: "string", minLength: 1, maxLength: 256 },
			kind: {
				type: "string",
				enum: [
					"click",
					"fill",
					"select",
					"check",
					"uncheck",
					"press",
					"hover",
					"scroll",
					"wait",
				],
			},
			value: { type: "string", maxLength: 4096 },
			key: { type: "string", maxLength: 64 },
		},
		required: ["pageId", "pageRevision", "elementId", "kind"],
	},
	files: {
		type: "object",
		additionalProperties: false,
		properties: {
			...pageReferenceProperties,
			kind: { type: "string", enum: ["screenshot", "download", "upload"] },
			fileId: { type: "string", minLength: 1, maxLength: 256 },
		},
		required: ["pageId", "pageRevision", "kind"],
	},
	handoff: {
		type: "object",
		additionalProperties: false,
		properties: { reason: { type: "string", minLength: 1, maxLength: 512 } },
		required: ["reason"],
	},
	side_effects: {
		type: "object",
		additionalProperties: false,
		properties: {
			...pageReferenceProperties,
			actionId: { type: "string", minLength: 1, maxLength: 256 },
			confirmationId: { type: "string", minLength: 1, maxLength: 256 },
		},
		required: ["pageId", "pageRevision", "actionId"],
	},
};

const descriptions: Record<CodexBrowserToolOperationV1, string> = {
	navigate: "Navigate within the deployment-approved Browser origins.",
	observe:
		"Observe bounded page text, elements, page revision and tab metadata.",
	interact:
		"Interact with a current opaque element reference; side effects require confirmation.",
	files:
		"Exchange authorized Browser artifacts through the existing File Grant boundary.",
	handoff: "Pause Browser automation for a controlled user handoff.",
	side_effects:
		"Continue a previously approved side-effect action bound to the current page revision.",
};

/** Build only bounded descriptors from an already verified capability projection. */
export function createCodexBrowserToolDescriptorsV1(
	capability: BrowserCapabilityAvailableV1 | undefined,
): readonly CodexBrowserToolDescriptorV1[] {
	if (capability?.status !== "available") return [];
	return capability.operations.map((operation) => ({
		name: `browser_${operation}` as `browser_${CodexBrowserToolOperationV1}`,
		description: descriptions[operation],
		operation,
		capabilityVersion: capability.capabilityVersion,
		inputSchema: structuredClone(schemas[operation]),
	}));
}
