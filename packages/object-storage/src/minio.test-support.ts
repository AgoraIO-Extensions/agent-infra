import { execFile as callback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
	CreateBucketCommand,
	PutBucketVersioningCommand,
	S3Client,
} from "@aws-sdk/client-s3";

import { createS3ObjectStorageV1 } from "./s3.ts";

const execFile = promisify(callback);
export async function startMinioFileFixtureV1() {
	const name = `agent-infra-442-s3-${randomUUID()}`;
	const credentials = {
		accessKeyId: "file_contract",
		secretAccessKey: "file_contract_password",
	};
	await execFile("docker", [
		"run",
		"--detach",
		"--rm",
		"--name",
		name,
		"--publish",
		"127.0.0.1::9000",
		"--env",
		`MINIO_ROOT_USER=${credentials.accessKeyId}`,
		"--env",
		`MINIO_ROOT_PASSWORD=${credentials.secretAccessKey}`,
		"cgr.dev/chainguard/minio@sha256:4d397a26fe49d7f9ed39b8b566534848936f7efa50ab6328ac97b2a44eeabf4c",
		"server",
		"/data",
	]);
	let client: S3Client | undefined;
	try {
		const { stdout } = await execFile("docker", ["port", name, "9000/tcp"]);
		const endpoint = `http://127.0.0.1:${stdout.trim().split(":").at(-1)}`;
		for (let attempt = 0; attempt < 60; attempt++) {
			if (
				await fetch(`${endpoint}/minio/health/ready`)
					.then((r) => r.ok)
					.catch(() => false)
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		client = new S3Client({
			endpoint,
			region: "us-east-1",
			forcePathStyle: true,
			credentials,
			// Startup may still return XMinioServerNotInitialized (503). Use the
			// SDK's bounded transient-error retries only for fixture provisioning.
			maxAttempts: 5,
		});
		await client.send(new CreateBucketCommand({ Bucket: "file-contract" }));
		await client.send(
			new PutBucketVersioningCommand({
				Bucket: "file-contract",
				VersioningConfiguration: { Status: "Enabled" },
			}),
		);
		const storage = createS3ObjectStorageV1({
			endpoint,
			region: "us-east-1",
			credentials,
			bucket: "file-contract",
			prefix: "files/",
			maxObjectBytes: 1024 * 1024,
			timeoutMs: 10000,
		});
		return {
			storage,
			async close() {
				storage.close();
				client?.destroy();
				await execFile("docker", ["rm", "--force", "--volumes", name]);
			},
		};
	} catch (error) {
		client?.destroy();
		await execFile("docker", ["rm", "--force", "--volumes", name]);
		throw error;
	}
}
