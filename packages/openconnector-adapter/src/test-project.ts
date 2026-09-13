type Catalog = {
	provider: string;
	actions: readonly {
		effect: "READ" | "WRITE";
		id: string;
		name: string;
	}[];
};

export type CapabilityCoverage = {
	actionId: string;
	actionName: string;
	effect: "READ" | "WRITE";
	provider: string;
	strategy: "isolated-mutation" | "read-smoke";
};

export function capabilityCoverage(
	catalogs: readonly Catalog[],
): CapabilityCoverage[] {
	const actionIds = new Set<string>();
	return catalogs.flatMap((catalog) =>
		catalog.actions.map((action) => {
			if (action.effect !== "READ" && action.effect !== "WRITE") {
				throw new Error(`unsupported effect for ${action.id}`);
			}
			if (actionIds.has(action.id)) {
				throw new Error(`duplicate ActionVersion id: ${action.id}`);
			}
			actionIds.add(action.id);
			return {
				actionId: action.id,
				actionName: action.name,
				effect: action.effect,
				provider: catalog.provider,
				strategy: action.effect === "READ" ? "read-smoke" : "isolated-mutation",
			};
		}),
	);
}

export type TestProject = {
	containerId: string;
	enabled: boolean;
	provider: string;
	runId: string;
	tenantId: string;
};

export type OwnedTestResource = {
	containerId: string;
	marker: string;
	provider: string;
	resourceId: string;
	runId: string;
	tenantId: string;
};

type TestProjectTarget = Pick<
	OwnedTestResource,
	"containerId" | "provider" | "tenantId"
>;

export function testResourceMarker(runId: string) {
	requireValue("runId", runId);
	return `connection-e2e:${runId}`;
}

export function assertTestProjectTarget(input: {
	project: TestProject;
	target: TestProjectTarget;
}) {
	const { project, target } = input;
	if (project.enabled !== true) {
		throw new Error("real-provider request is disabled");
	}
	for (const [name, value] of Object.entries(project)) {
		if (name !== "enabled") requireValue(name, value);
	}
	for (const field of ["provider", "tenantId", "containerId"] as const) {
		if (target[field] !== project[field]) {
			throw new Error(`test project ${field} does not match`);
		}
	}
}

export async function runTestProjectRead<T>(input: {
	execute: () => Promise<T>;
	project: TestProject;
	target: TestProjectTarget;
}) {
	assertTestProjectTarget(input);
	return input.execute();
}

export function assertTestProjectMutation(input: {
	operation: "CREATE" | "DELETE" | "UPDATE";
	project: TestProject;
	target: Omit<OwnedTestResource, "resourceId">;
	resource?: OwnedTestResource;
}) {
	const { operation, project, resource, target } = input;
	assertTestProjectTarget({ project, target });
	if (target.runId !== project.runId) {
		throw new Error("test project runId does not match");
	}
	if (target.marker !== testResourceMarker(project.runId)) {
		throw new Error("test resource ownership marker does not match");
	}

	if (operation === "CREATE") return;
	if (!resource) {
		throw new Error(`${operation} requires a recorded test resource`);
	}
	requireValue("resourceId", resource.resourceId);
	for (const field of [
		"provider",
		"tenantId",
		"containerId",
		"runId",
		"marker",
	] as const) {
		if (resource[field] !== target[field]) {
			throw new Error(`recorded test resource ${field} does not match`);
		}
	}
}

export async function runTestProjectMutation<T>(input: {
	execute: () => Promise<T>;
	operation: "CREATE" | "DELETE" | "UPDATE";
	project: TestProject;
	target: Omit<OwnedTestResource, "resourceId">;
	resource?: OwnedTestResource;
}) {
	assertTestProjectMutation(input);
	return input.execute();
}

function requireValue(name: string, value: unknown) {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`test project ${name} is required`);
	}
}
