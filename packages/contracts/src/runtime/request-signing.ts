export function canonicalRuntimeRequestSigningPayload(request: {
	grant: unknown;
	[key: string]: unknown;
}): string {
	const { grant: _grant, ...payload } = request;
	function canonical(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(canonical);
		if (value !== null && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value)
					.filter(([, entry]) => entry !== undefined)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([key, entry]) => [key, canonical(entry)]),
			);
		}
		return value;
	}
	return JSON.stringify(canonical(payload));
}
