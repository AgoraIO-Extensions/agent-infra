import { request } from "node:http";

/** Node fetch rewrites Host; these local fixture tests must send it exactly. */
export function postOwnEntryFixture(
	url: string,
	options: { headers: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Headers }> {
	return new Promise((resolve, reject) => {
		const pending = request(
			url,
			{
				method: "POST",
				headers: options.headers,
				signal: AbortSignal.timeout(3000),
			},
			(response) => {
				const headers = new Headers();
				for (let index = 0; index < response.rawHeaders.length; index += 2)
					headers.append(
						response.rawHeaders[index]!,
						response.rawHeaders[index + 1]!,
					);
				response.resume();
				response.once("end", () =>
					resolve({ status: response.statusCode ?? 0, headers }),
				);
			},
		);
		pending.once("error", reject);
		pending.end(options.body);
	});
}
