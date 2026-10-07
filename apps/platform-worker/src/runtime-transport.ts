/**
 * In-cluster Worker → RuntimeHost transport (ADR-0020): plaintext HTTP to an
 * exact Service origin. Authorization stays with the service token and signed
 * Grant; NetworkPolicy admits only the Worker. Redirects are never followed.
 */
export const runtimeFetch: typeof fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (
		url.protocol !== "http:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error("RUNTIME_ORIGIN_INVALID");
	return fetch(input, { ...init, redirect: "error" });
};
