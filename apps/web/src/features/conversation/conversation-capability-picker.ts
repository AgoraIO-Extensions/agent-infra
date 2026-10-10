export type ConversationCapabilityV1 = Readonly<{
	kind: "command" | "skill";
	name: string;
	description: string;
	source: string;
	version?: string;
	parameterHint?: string;
}>;

export type ConversationCapabilitySelectionV1 = Readonly<{
	kind: ConversationCapabilityV1["kind"];
	name: string;
	parameterText: string;
}>;

export type ConversationCapabilityPickerStateV1 = Readonly<{
	scopeKey: string;
	query: string;
	selectedIndex: number;
	selected: ConversationCapabilityV1 | undefined;
	parameterText: string;
	confirmed: boolean;
}>;

const maximumCapabilities = 150;
const maximumQueryBytes = 512;
const maximumParameterBytes = 4096;

function bounded(value: string, maximum: number) {
	return value.isWellFormed() && Buffer.byteLength(value, "utf8") <= maximum;
}

export function filterConversationCapabilities(
	capabilities: readonly ConversationCapabilityV1[],
	query: string,
) {
	if (
		capabilities.length > maximumCapabilities ||
		!bounded(query, maximumQueryBytes)
	)
		return [] as readonly ConversationCapabilityV1[];
	const normalized = query.trim().replace(/^\/+/, "").toLocaleLowerCase();
	return capabilities
		.filter((capability) => {
			const haystack =
				`${capability.name} ${capability.description} ${capability.source}`.toLocaleLowerCase();
			return normalized.length === 0 || haystack.includes(normalized);
		})
		.slice(0, maximumCapabilities);
}

export function createConversationCapabilityPickerState(
	scopeKey: string,
): ConversationCapabilityPickerStateV1 {
	return {
		scopeKey,
		query: "",
		selectedIndex: 0,
		selected: undefined,
		parameterText: "",
		confirmed: false,
	};
}

export function updateConversationCapabilityQuery(
	state: ConversationCapabilityPickerStateV1,
	query: string,
): ConversationCapabilityPickerStateV1 {
	return {
		...state,
		query: bounded(query, maximumQueryBytes) ? query : "",
		selectedIndex: 0,
		selected: undefined,
		parameterText: "",
		confirmed: false,
	};
}

export function moveConversationCapabilitySelection(
	state: ConversationCapabilityPickerStateV1,
	capabilities: readonly ConversationCapabilityV1[],
	delta: -1 | 1,
) {
	const filtered = filterConversationCapabilities(capabilities, state.query);
	if (filtered.length === 0) return { ...state, selectedIndex: 0 };
	return {
		...state,
		selectedIndex:
			(state.selectedIndex + delta + filtered.length) % filtered.length,
	};
}

export function selectConversationCapability(
	state: ConversationCapabilityPickerStateV1,
	capability: ConversationCapabilityV1 | undefined,
) {
	return {
		...state,
		selected: capability,
		parameterText: "",
		confirmed: false,
	};
}

export function updateConversationCapabilityParameter(
	state: ConversationCapabilityPickerStateV1,
	parameterText: string,
) {
	return {
		...state,
		parameterText: bounded(parameterText, maximumParameterBytes)
			? parameterText
			: "",
		confirmed: false,
	};
}

export function confirmConversationCapability(
	state: ConversationCapabilityPickerStateV1,
): ConversationCapabilitySelectionV1 | undefined {
	if (!state.selected || !bounded(state.parameterText, maximumParameterBytes))
		return undefined;
	return {
		kind: state.selected.kind,
		name: state.selected.name,
		parameterText: state.parameterText,
	};
}

export function markConversationCapabilityConfirmed(
	state: ConversationCapabilityPickerStateV1,
) {
	return {
		...state,
		confirmed: confirmConversationCapability(state) !== undefined,
	};
}

export function resetConversationCapabilityScope(
	state: ConversationCapabilityPickerStateV1,
	scopeKey: string,
) {
	return state.scopeKey === scopeKey
		? state
		: createConversationCapabilityPickerState(scopeKey);
}
