import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { standardTemplateRegistryFromDeploymentV1 } from "../../packages/image-registry/src/deployment.ts";

type Image = { repository: string; digest: string };
type Template = { templateId: string; imageRepository: string; imageDigest: string };
type RegistryBinding = {
	endpoint: string;
	imageReferencePrefix: string;
	repositories: string[];
	authentication: { realm: string; service: string };
	credentialsSecretRef: { name: string; key: string };
};

// Inspect only the literal deployment bindings. Never execute private configuration modules.
function moduleBindings(source: string, role: "api" | "worker", imagePullSecretName: string) {
	assert(!ts.transpileModule(source, { fileName: "configuration.mjs", compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext }, reportDiagnostics: true }).diagnostics?.some((entry) => entry.category === ts.DiagnosticCategory.Error));
	const file = ts.createSourceFile("configuration.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const declarations = new Map<string, ts.Expression>();
	const constants = new Set<string>();
	const exported = new Set<string>();
	const protectedNames = new Map<string, "root" | "value">();
	for (const statement of file.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (ts.isIdentifier(declaration.name) && declaration.initializer) {
				assert(!declarations.has(declaration.name.text));
				declarations.set(declaration.name.text, declaration.initializer);
				if (statement.declarationList.flags & ts.NodeFlags.Const) constants.add(declaration.name.text);
				if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) exported.add(declaration.name.text);
			}
		}
	}
	const resolve = (node: ts.Expression | undefined, seen = new Set<string>(), kind: "root" | "value" = "value"): ts.Expression => {
		assert(node);
		if (!ts.isIdentifier(node)) return node;
		assert(!seen.has(node.text));
		assert(constants.has(node.text));
		protectedNames.set(node.text, kind);
		seen.add(node.text);
		return resolve(declarations.get(node.text), seen, kind);
	};
	const property = (node: ts.Expression, name: string) => {
		const object = resolve(node);
		assert(ts.isObjectLiteralExpression(object));
		assert(!object.properties.some(ts.isSpreadAssignment));
		assert(!object.properties.some((entry) => ts.isGetAccessor(entry) || ts.isSetAccessor(entry)));
		const names = object.properties.map((entry) => {
			assert(entry.name && (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)));
			return entry.name.text;
		});
		assert(new Set(names).size === names.length);
		const entries = object.properties.filter((entry) => entry.name &&
			(ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) && entry.name.text === name);
		assert(entries.length === 1);
		const entry = entries[0];
		if (ts.isShorthandPropertyAssignment(entry)) return resolve(entry.name);
		assert(ts.isPropertyAssignment(entry));
		return resolve(entry.initializer);
	};
	const text = (node: ts.Expression) => {
		const value = resolve(node);
		assert(ts.isStringLiteral(value));
		return value.text;
	};
	const rootName = role === "api" ? "apiInput" : "workloadInput";
	for (const statement of file.statements) {
		if (!ts.isExportDeclaration(statement)) continue;
		assert(!statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause));
		for (const specifier of statement.exportClause.elements) {
			const localName = specifier.propertyName?.text ?? specifier.name.text;
			if (specifier.name.text === rootName) {
				assert(localName === rootName);
				exported.add(rootName);
			}
		}
	}
	assert(exported.has(rootName));
	protectedNames.set(rootName, "root");
	const root = resolve(declarations.get(rootName), new Set(), "root");
	const registry = property(root, "registry");
	assert(ts.isObjectLiteralExpression(registry) && !registry.properties.some((entry) => entry.name &&
		(ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) && entry.name.text === "standardTemplates"));
	assert(text(property(registry, "endpoint")) === "https://ghcr.io");
	assert(text(property(registry, "imageReferencePrefix")) === "ghcr.io");
	const templates = property(root, role === "api" ? "templates" : "templateModelBindings");
	assert(ts.isArrayLiteralExpression(templates));
	const result = templates.elements.map((entry): Template => {
		const templateId = text(property(entry, "templateId"));
		const imageDigest = text(property(entry, "imageDigest"));
		if (role === "worker") return { templateId, imageDigest, imageRepository: text(property(entry, "imageRepository")) };
		const reference = text(property(entry, "imageReference"));
		assert(reference.endsWith(`@${imageDigest}`));
		return { templateId, imageDigest, imageRepository: reference.slice(0, -(imageDigest.length + 1)) };
	});
	const pullAssignments = new Set<ts.Node>();
	if (role === "worker") {
		const policy = property(root, "policy");
		assert(ts.isObjectLiteralExpression(policy));
		let selected: string | undefined;
		if (policy.properties.some((entry) => entry.name && entry.name.getText(file).replace(/["']/gu, "") === "imagePullSecretName")) selected = text(property(policy, "imagePullSecretName"));
		const pullWrites = (node: ts.Node) => {
			if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && node.left.name.text === "imagePullSecretName") {
				const owner = node.left.expression;
				if (ts.isPropertyAccessExpression(owner) && owner.name.text === "policy" && ts.isIdentifier(owner.expression) && protectedNames.get(owner.expression.text) === "root") {
					assert(ts.isExpressionStatement(node.parent) && ts.isSourceFile(node.parent.parent));
					assert(text(node.right) === imagePullSecretName);
					selected = imagePullSecretName;
					pullAssignments.add(node);
				}
			}
			ts.forEachChild(node, pullWrites);
		};
		pullWrites(file);
		assert(selected === imagePullSecretName);
	}
	const pathBinding = (node: ts.Node): boolean | undefined => {
		const properties: (string | undefined)[] = [];
		while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isParenthesizedExpression(node)) {
			if (ts.isParenthesizedExpression(node)) { node = node.expression; continue; }
			properties.unshift(ts.isPropertyAccessExpression(node) ? node.name.text : node.argumentExpression && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined);
			node = node.expression;
		}
		if (!ts.isIdentifier(node)) return undefined;
		const kind = protectedNames.get(node.text);
		if (!kind) return undefined;
		return kind === "value" || properties.length === 0 || properties[0] === undefined || ["policy", "registry", "templates", "templateModelBindings"].includes(properties[0]);
	};
	const touches = (node: ts.Node): boolean => {
		if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
			const protectedPath = pathBinding(node);
			if (protectedPath !== undefined) return protectedPath;
		}
		if (ts.isIdentifier(node) && protectedNames.has(node.text)) {
			const parent = node.parent;
			if (ts.isPropertyAccessExpression(parent) && parent.name === node ||
				ts.isPropertyAssignment(parent) && parent.name === node ||
				ts.isVariableDeclaration(parent) && parent.name === node) return false;
			return true;
		}
		return ts.forEachChild(node, (child) => touches(child) || undefined) === true;
	};
	// Aliases may otherwise hide a later assignment or a call that mutates the selected bindings.
	for (let previous = -1; previous !== protectedNames.size;) {
		previous = protectedNames.size;
		for (const [name, initializer] of declarations) if (!protectedNames.has(name) && touches(initializer)) protectedNames.set(name, ts.isIdentifier(initializer) && protectedNames.get(initializer.text) === "root" ? "root" : "value");
	}
	const mutates = (node: ts.Node) =>
		ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ||
		ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) || ts.isDeleteExpression(node);
	const readOnlyMethods = new Set(["every", "filter", "find", "findIndex", "includes", "indexOf", "join", "lastIndexOf", "map", "slice", "some"]);
	const pure = (node: ts.Node): boolean => {
		if (mutates(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) return false;
		if (ts.isCallExpression(node)) {
			if (!ts.isPropertyAccessExpression(node.expression) || !readOnlyMethods.has(node.expression.name.text)) return false;
			return pure(node.expression.expression) && node.arguments.every(pure);
		}
		return ts.forEachChild(node, (child) => !pure(child) || undefined) !== true;
	};
	const check = (node: ts.Node) => {
		if (pullAssignments.has(node)) return;
		if (mutates(node)) assert(!touches(node));
		if (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name) && node.initializer) assert(!touches(node.initializer));
		if (ts.isPropertyDeclaration(node) && node.initializer) assert(!touches(node.initializer));
		if (ts.isForOfStatement(node) || ts.isForInStatement(node)) assert(!touches(node.expression));
		if (ts.isReturnStatement(node) && node.expression) assert(!touches(node.expression));
		if (ts.isTaggedTemplateExpression(node)) assert(!touches(node));
		if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
			assert(!(ts.isIdentifier(node.expression) && ["eval", "Function"].includes(node.expression.text)));
			assert(!(node.arguments ?? []).some(touches));
			if (touches(node.expression)) {
				assert(ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && readOnlyMethods.has(node.expression.name.text));
				assert(node.arguments.every((argument) => !touches(argument) && pure(argument)));
			}
		}
		ts.forEachChild(node, check);
	};
	check(file);
	return result;
}

function configurationSource(documents: any[], pod: any, container: any, role: "api" | "worker") {
	const path = role === "api" ? "/app/deployment/configuration.mjs" : "/app/dist/configuration.mjs";
	const mounts = container.volumeMounts?.filter((mount: any) => mount.mountPath === path ||
		(!mount.subPath && path.startsWith(`${mount.mountPath}/`)));
	assert(mounts?.length === 1 && mounts[0].readOnly === true && !mounts[0].subPathExpr);
	assert(!mounts[0].subPath || mounts[0].subPath === "configuration.mjs");
	const volume = pod.volumes?.find((entry: any) => entry.name === mounts[0].name);
	assert(volume?.secret && !volume.secret.items);
	const secrets = documents.filter((entry) => entry.kind === "Secret" && entry.metadata.name === volume.secret.secretName);
	assert(secrets.length === 1 && typeof secrets[0].data?.["configuration.mjs"] === "string");
	return Buffer.from(secrets[0].data["configuration.mjs"], "base64").toString("utf8");
}

/** Pre-write check of the exact rendered consumers, Secret projections and release bindings. */
export function validateStandardTemplateRegistryDeploymentV1(input: {
	documents: any[];
	namespace: string;
	imagePullSecretName: string;
	binding: RegistryBinding;
	currentTemplates: Record<string, Image>;
	retainedTemplates: Template[];
	requiredRetainedTemplates: Template[];
}) {
	let consumer = "shared";
	try {
		const {
			binding,
			currentTemplates,
			retainedTemplates,
			requiredRetainedTemplates,
			namespace,
			imagePullSecretName,
		} = input;
		assert(typeof namespace === "string" && namespace.length > 0);
		const documents = input.documents.filter((entry) => !entry.metadata?.namespace || entry.metadata.namespace === namespace);
		const { credentialsSecretRef, ...expected } = binding;
		assert(credentialsSecretRef?.name && credentialsSecretRef.key);
		assert(typeof imagePullSecretName === "string" && imagePullSecretName.length > 0 && imagePullSecretName !== credentialsSecretRef.name);
		const identities = documents.filter((entry) => entry.kind === "Secret" && entry.metadata.name === credentialsSecretRef.name);
		assert(identities.length === 1 && (typeof identities[0].data?.[credentialsSecretRef.key] === "string" || typeof identities[0].stringData?.[credentialsSecretRef.key] === "string"));
		standardTemplateRegistryFromDeploymentV1(JSON.stringify(expected));
		const ids = ["codex", "claude", "opencode", "pi"];
		assert(isDeepStrictEqual(Object.keys(currentTemplates).sort(), [...ids].sort()));
		const current = ids.map((templateId) => ({ templateId, imageRepository: currentTemplates[templateId].repository, imageDigest: currentTemplates[templateId].digest }));
		assert(isDeepStrictEqual([...expected.repositories].sort(), current.map((entry) => {
			assert(entry.imageRepository.startsWith(`${expected.imageReferencePrefix}/`));
			assert(/^sha256:[a-f0-9]{64}$/u.test(entry.imageDigest));
			return entry.imageRepository.slice(expected.imageReferencePrefix.length + 1);
		}).sort()));
		const key = (entry: Template) => `${entry.templateId}:${entry.imageRepository}@${entry.imageDigest}`;
		const approved = new Set([...current, ...retainedTemplates].map(key));
		const requiredRetainedKeys = new Set(requiredRetainedTemplates.map(key));
		assert(requiredRetainedKeys.size === requiredRetainedTemplates.length);
		for (const entry of requiredRetainedTemplates) assert(approved.has(key(entry)));
		let templateBindings = 0;
		for (const role of ["api", "worker"] as const) {
			consumer = role;
			const deployments = documents.filter((entry) => entry.kind === "Deployment" && entry.metadata.name === `agent-infra-${role}`);
			assert(deployments.length === 1);
			const pod = deployments[0].spec.template.spec;
			const container = pod.containers.find((entry: any) => entry.name === `platform-${role}`);
			assert(container && !container.envFrom);
			const entryVariable = role === "api" ? "PLATFORM_API_CONFIGURATION_MODULE" : "PLATFORM_WORKER_DEPLOYMENT_MODULE";
			const entries = container.env?.filter((entry: any) => entry.name === entryVariable);
			assert(entries?.length === 1 && entries[0].value === (role === "api" ? "file:///app/deployment/configuration.mjs" : "file:///app/dist/deployment.mjs") && !entries[0].valueFrom);
			const environments = container.env?.filter((entry: any) => entry.name === "AGENT_INFRA_STANDARD_TEMPLATE_REGISTRY");
			assert(environments?.length === 1 && typeof environments[0].value === "string" && !environments[0].valueFrom);
			assert(isDeepStrictEqual(JSON.parse(environments[0].value), expected));
			const volumes = pod.volumes?.filter((entry: any) => entry.secret?.secretName === credentialsSecretRef.name);
			assert(volumes?.length === 1);
			const volume = volumes[0];
			assert(volume.secret.defaultMode === 0o440 && volume.secret.optional !== true);
			assert(isDeepStrictEqual(volume.secret.items, [{ key: credentialsSecretRef.key, path: "credentials.json" }]));
			const mounts = container.volumeMounts?.filter((entry: any) => entry.name === volume.name);
			assert(mounts?.length === 1 && mounts[0].readOnly === true && !mounts[0].subPath && !mounts[0].subPathExpr && mounts[0].mountPath === "/var/run/agent-infra/standard-template-registry");
			const bindings = moduleBindings(configurationSource(documents, pod, container, role), role, imagePullSecretName);
			assert(bindings.length > 0 && bindings.every((entry) => approved.has(key(entry))));
			for (const entry of current) assert(bindings.some((binding) => key(entry) === key(binding)));
			if (role === "worker") for (const entry of requiredRetainedTemplates) assert(bindings.some((binding) => key(entry) === key(binding)));
			if (role === "api") assert(bindings.length === 4);
			else templateBindings = new Set(bindings.map(key)).size;
		}
		consumer = "secret-isolation";
		for (const document of documents) {
			const pod = document.kind === "Pod" ? document.spec : document.kind === "CronJob" ? document.spec?.jobTemplate?.spec?.template?.spec : document.spec?.template?.spec;
			if (!pod) continue;
			const names = (pod.volumes ?? []).filter((entry: any) => entry.secret?.secretName === credentialsSecretRef.name || entry.projected?.sources?.some((source: any) => source.secret?.name === credentialsSecretRef.name)).map((entry: any) => entry.name);
			assert(!pod.imagePullSecrets?.some((entry: any) => entry.name === credentialsSecretRef.name));
			if (names.length) assert(document.kind === "Deployment" && ["agent-infra-api", "agent-infra-worker"].includes(document.metadata.name));
			for (const container of [...(pod.initContainers ?? []), ...(pod.containers ?? []), ...(pod.ephemeralContainers ?? [])]) {
				assert(!container.envFrom?.some((entry: any) => entry.secretRef?.name === credentialsSecretRef.name));
				assert(!container.env?.some((entry: any) => entry.valueFrom?.secretKeyRef?.name === credentialsSecretRef.name));
				if (!container.volumeMounts?.some((entry: any) => names.includes(entry.name))) continue;
				assert(document.kind === "Deployment" && ["api", "worker"].some((role) => document.metadata.name === `agent-infra-${role}` && container.name === `platform-${role}`));
			}
		}
		return { status: "passed", templateBindings, businessVerified: false } as const;
	} catch {
		return { status: "failed", failureCode: "STANDARD_TEMPLATE_REGISTRY_BINDING_INVALID", consumer, businessVerified: false } as const;
	}
}
