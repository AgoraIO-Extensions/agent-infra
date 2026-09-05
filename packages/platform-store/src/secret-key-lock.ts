export function secretKeyAdvisoryLockName(keyVersion: string): string {
	return `agent-infra:secret-key:${keyVersion}`;
}
