export interface EnvironmentNavigationTarget {
  readonly projectId: string | null
  readonly environmentId: string | null
  readonly pluginInstanceId: string | null
}

export function reconcileEnvironmentExpansion(
  current: readonly string[],
  environmentIds: readonly string[],
  target: EnvironmentNavigationTarget,
  previousTarget: EnvironmentNavigationTarget | null,
  previousEnvironmentIds: readonly string[] = environmentIds,
): readonly string[] {
  const validIds = new Set(environmentIds)
  const selectedId = target.environmentId !== null && validIds.has(target.environmentId)
    ? target.environmentId
    : null
  const projectChanged = previousTarget === null || previousTarget.projectId !== target.projectId
  const environmentsBecameAvailable = previousEnvironmentIds.length === 0 && environmentIds.length > 0
  let next = projectChanged ? [] : current.filter((environmentId) => validIds.has(environmentId))

  if (projectChanged || environmentsBecameAvailable) {
    const initialId = selectedId ?? environmentIds[0]
    if (initialId) next = [initialId]
  } else if (selectedId && (
    target.environmentId !== previousTarget.environmentId
    || (target.pluginInstanceId !== null && target.pluginInstanceId !== previousTarget.pluginInstanceId)
    || !previousEnvironmentIds.includes(selectedId)
  )) {
    // Reveal a new navigation destination once. Repeated summaries and runtime
    // updates must preserve a user's choice to close the selected environment.
    if (!next.includes(selectedId)) next = [...next, selectedId]
  }

  return next.length === current.length && next.every((id, index) => id === current[index])
    ? current
    : next
}
