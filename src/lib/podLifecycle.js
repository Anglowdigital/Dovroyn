// One scope per mounted workspace. The route ID is updated during rendering,
// so stale work is rejected even before the previous effect's cleanup runs.
export function startPodLifecycle(scope, podId) {
  if (scope.current) scope.current.active = false;
  const lifecycle = { podId, active: true, operations: new Map() };
  scope.current = lifecycle;
  return lifecycle;
}

export function isPodActionPending(scope, group) {
  const lifecycle = scope.current;
  return Boolean(lifecycle?.active && lifecycle.podId === scope.podId && lifecycle.operations.has(group));
}

export function capturePodAction(scope, podId, group) {
  const lifecycle = scope.current;
  const isLifecycleCurrent = () => Boolean(podId && lifecycle?.active && scope.current === lifecycle
    && lifecycle.podId === podId && scope.podId === podId);
  if (!isLifecycleCurrent() || (group && lifecycle.operations.has(group))) return null;
  const token = {};
  if (group) lifecycle.operations.set(group, token);
  const isCurrent = () => isLifecycleCurrent() && (!group || lifecycle.operations.get(group) === token);
  return {
    podId,
    isCurrent,
    finish() {
      // An old finally must not release a newer lifecycle's operation lock.
      if (!isCurrent()) return false;
      if (group) lifecycle.operations.delete(group);
      return true;
    },
  };
}
