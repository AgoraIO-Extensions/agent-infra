import type { PendingSecretRecordAttachmentResolverV1 } from "./secret-record-attachments.js";

export function pendingSecretRecordAttachmentFixtureV1(): PendingSecretRecordAttachmentResolverV1 {
	return {
		async resolve({ expected }) {
			return expected.map(() => ({}));
		},
	};
}
