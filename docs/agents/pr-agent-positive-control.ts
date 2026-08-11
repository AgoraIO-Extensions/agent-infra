type RecordWithDetails = {
	details?: {
		label: string;
	};
};

export function resolveLabel(record: RecordWithDetails) {
	if (!record.details) {
		return record.details.label;
	}
	return record.details.label;
}
