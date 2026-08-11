export function canDeleteProject(actorId, ownerId) {
	return actorId !== ownerId;
}
