import { ScopedPlatformAuditPageV1Schema } from "../../packages/contracts/src/pilot/audit.ts";

export function validateAuditBrowserFixture(payload, expectedPrincipal) {
	let page;
	try {
		page = ScopedPlatformAuditPageV1Schema.parse(payload);
	} catch {
		return null;
	}
	if (!expectedPrincipal || typeof expectedPrincipal.id !== "string")
		return null;
	if (
		page.items.some(
			(item) =>
				item.originalPrincipal?.kind !== expectedPrincipal.kind ||
				item.originalPrincipal.id !== expectedPrincipal.id,
		)
	)
		return null;
	return {
		count: page.items.length,
		nextCursor: page.nextCursor,
		auditIds: page.items.map((item) => item.auditId),
		containsSensitiveBody: JSON.stringify(payload).includes(
			"PRIVATE_SYNTHETIC_AUDIT_BODY",
		),
	};
}
