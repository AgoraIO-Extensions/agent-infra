export type EmployeeDirectoryOptions = { url: string; serviceKey: string };

export function validateEmployeeDirectory(options: EmployeeDirectoryOptions) {
	const url = new URL(options.url);
	if (url.protocol !== "https:" || url.username || url.password || url.hash) {
		throw new Error(
			"Employee directory requires an HTTPS URL without credentials or fragment",
		);
	}
	if (!options.serviceKey.trim() || /[\r\n]/.test(options.serviceKey)) {
		throw new Error("Employee directory service key is required");
	}
	return options;
}

// Only this projection is retained; the upstream response contains other HR data.
export async function searchDirectoryEmployees(
	options: EmployeeDirectoryOptions,
	query: string,
	signal: AbortSignal,
) {
	const response = await fetch(options.url, {
		headers: {
			"agora-service-key": options.serviceKey,
			Accept: "application/json",
		},
		redirect: "error",
		signal,
	});
	if (!response.ok || !response.body)
		throw new Error("Employee directory unavailable");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > 5 * 1024 * 1024)
				throw new Error("Employee directory response too large");
			chunks.push(chunk.value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (!Array.isArray(payload) || payload.length > 50_000) {
		throw new Error("Invalid employee directory response");
	}
	const normalized = query.toLowerCase();
	const employees: Array<{ name: string; email: string }> = [];
	const emails = new Set<string>();
	for (const item of payload) {
		if (!item || typeof item !== "object" || !item.iamId) continue;
		if (typeof item.name !== "string" || typeof item.email !== "string") {
			throw new Error("Invalid employee directory record");
		}
		const name = item.name.trim();
		const email = item.email.trim().toLowerCase();
		if (
			!name ||
			name.length > 256 ||
			email.length > 320 ||
			!/^[^\s@]+@[^\s@]+$/.test(email)
		) {
			throw new Error("Invalid employee directory record");
		}
		if (!name.toLowerCase().includes(normalized) && !email.includes(normalized))
			continue;
		if (emails.has(email))
			throw new Error("Ambiguous employee directory record");
		emails.add(email);
		employees.push({ name, email });
	}
	return employees.slice(0, 20);
}
