export function isPostgresError(error: unknown, code: string): boolean {
	try {
		let current = error;
		for (let depth = 0; depth < 4; depth += 1) {
			if (typeof current !== "object" || current === null) return false;
			const descriptors = Object.getOwnPropertyDescriptors(current);
			const codeDescriptor = descriptors.code;
			if (
				codeDescriptor &&
				Object.hasOwn(codeDescriptor, "value") &&
				codeDescriptor.value === code
			) {
				return true;
			}
			const causeDescriptor = descriptors.cause;
			current =
				causeDescriptor && Object.hasOwn(causeDescriptor, "value")
					? causeDescriptor.value
					: undefined;
		}
		return false;
	} catch {
		return false;
	}
}
