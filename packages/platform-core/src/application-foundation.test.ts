import { describe } from "vitest";

import { applicationFoundationTransactionConformance } from "./application-foundation.conformance.ts";
import { FakeApplicationFoundationTransactionV1 } from "./fake-application-foundation.ts";

describe("Fake application foundation transaction", () => {
	applicationFoundationTransactionConformance(async () => {
		const transaction = new FakeApplicationFoundationTransactionV1();
		return {
			transaction,
			failNextBefore: (point) => transaction.failNextBefore(point),
			snapshot: () => Promise.resolve(transaction.snapshot()),
			close: () => Promise.resolve(),
		};
	});
});
