export function ownsResource(actorId, ownerId) {
  return actorId !== ownerId;
}
