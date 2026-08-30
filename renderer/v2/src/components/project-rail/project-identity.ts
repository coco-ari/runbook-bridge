interface ProjectIdentitySource {
  readonly projectId: string
  readonly name: string
}

interface ProjectRailIdentity {
  monogram: string
  shortName: string
}

const graphemeSegmenter = new Intl.Segmenter("und", { granularity: "grapheme" })

function graphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment)
}

function meaningfulSegments(name: string): string[][] {
  const segments: string[][] = []
  let current: string[] = []
  for (const character of graphemes(name.normalize("NFC"))) {
    if (/[\p{L}\p{N}]/u.test(character) && !/[\p{Extended_Pictographic}\u20e3]/u.test(character)) {
      current.push(character)
    } else if (current.length > 0) {
      segments.push(current)
      current = []
    }
  }
  if (current.length > 0) segments.push(current)
  return segments
}

function monogramFor(firstSegment: readonly string[]): string {
  const first = firstSegment[0] ?? "项"
  if (!/\p{Script=Latin}/u.test(first)) return first
  const letters = firstSegment.slice(0, 2).filter((letter) => /\p{Script=Latin}/u.test(letter))
  return graphemes(letters.join("").toUpperCase()).slice(0, 2).join("")
}

function idCode(projectId: string, length: number): string {
  let hash = 2166136261
  for (let index = 0; index < projectId.length; index += 1) {
    hash = Math.imul(hash ^ projectId.charCodeAt(index), 16777619)
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(4, "0").slice(-length)
}

function uniqueIdLabel(base: string, projectId: string, used: ReadonlySet<string>): string {
  // Normally two ID-derived characters suffice. Resolve rare hash/name
  // collisions without using a project's position in the displayed list.
  for (let attempt = 0; ; attempt += 1) {
    const length = Math.min(2 + attempt, 4)
    const seed = attempt === 0 ? projectId : `${projectId}\u0000${attempt}`
    const label = graphemes(base).slice(0, 4 - length).join("") + idCode(seed, length)
    if (!used.has(label)) return label
  }
}

export function buildProjectRailIdentities(
  projects: readonly ProjectIdentitySource[],
): ReadonlyMap<string, ProjectRailIdentity> {
  const entries = projects.map(({ projectId, name }) => {
    const segments = meaningfulSegments(name)
    const first = segments[0] ?? ["项", "目"]
    return {
      projectId,
      name,
      monogram: monogramFor(first),
      base: first.slice(0, 4).join(""),
      characters: segments.length > 0 ? segments.flat() : first,
    }
  }).sort((left, right) => {
    const leftKey = left.projectId + "\u0000" + left.name
    const rightKey = right.projectId + "\u0000" + right.name
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })

  const groups = new Map<string, typeof entries>()
  for (const entry of entries) {
    const group = groups.get(entry.base) ?? []
    group.push(entry)
    groups.set(entry.base, group)
  }

  const preferred = new Map<string, string>()
  for (const group of groups.values()) {
    const first = group[0]
    if (!first) continue
    let commonLength = 0
    while (commonLength < first.characters.length && group.every(
      (entry) => entry.characters[commonLength] === first.characters[commonLength],
    )) commonLength += 1

    for (const entry of group) {
      const distinguishing = entry.characters.slice(commonLength, commonLength + 2)
      preferred.set(entry.projectId, group.length > 1 && distinguishing.length > 0
        ? graphemes(entry.base).slice(0, 2).join("") + distinguishing.join("")
        : entry.base)
    }
  }

  const counts = new Map<string, number>()
  for (const label of preferred.values()) counts.set(label, (counts.get(label) ?? 0) + 1)
  const used = new Set(Array.from(counts).filter(([, count]) => count === 1).map(([label]) => label))
  const identities = new Map<string, ProjectRailIdentity>()
  for (const entry of entries) {
    const label = preferred.get(entry.projectId) ?? entry.base
    const shortName = counts.get(label) === 1 ? label : uniqueIdLabel(label, entry.projectId, used)
    used.add(shortName)
    identities.set(entry.projectId, { monogram: entry.monogram, shortName })
  }
  return identities
}
