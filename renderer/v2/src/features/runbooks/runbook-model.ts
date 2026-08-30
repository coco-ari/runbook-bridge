export const RUNBOOK_MAX_BYTES = 65_536

type UnknownRecord = Readonly<Record<string, unknown>>

export interface RunbookReadToken {
  readonly scopeKey: string
  readonly epoch: number
  readonly draftGeneration: number
}

export interface RunbookReadCurrent {
  readonly scopeKey: string
  readonly epoch: number
  readonly draftGeneration: number
}

export interface RunbookReadDecision {
  readonly accept: boolean
  readonly replaceDraft: boolean
}

export interface RunbookEditorSnapshot extends RunbookReadCurrent {
  readonly content: string
  readonly draft: string
  readonly revision: number
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

export function runbookScopeKey(projectId: string, environmentId: string): string {
  return JSON.stringify([projectId, environmentId])
}

export function beginRunbookRead(
  scopeKey: string,
  epoch: number,
  draftGeneration: number,
): RunbookReadToken {
  return { scopeKey, epoch, draftGeneration }
}

export function decideRunbookRead(
  token: RunbookReadToken,
  current: RunbookReadCurrent,
  preserveDraft: boolean,
): RunbookReadDecision {
  const accept = token.scopeKey === current.scopeKey && token.epoch === current.epoch
  return {
    accept,
    replaceDraft: accept
      && !preserveDraft
      && token.draftGeneration === current.draftGeneration,
  }
}

export function applyRunbookRead(
  current: RunbookEditorSnapshot,
  token: RunbookReadToken,
  next: Readonly<{ content: string; revision: number }>,
  preserveDraft = false,
): RunbookEditorSnapshot {
  const decision = decideRunbookRead(token, current, preserveDraft)
  if (!decision.accept) return current
  return {
    ...current,
    content: next.content,
    draft: decision.replaceDraft ? next.content : current.draft,
    revision: next.revision,
    draftGeneration: decision.replaceDraft
      ? current.draftGeneration + 1
      : current.draftGeneration,
  }
}

export function runbookContent(value: unknown): string {
  const content = asRecord(value).content
  return typeof content === "string" ? content : ""
}

export function savedEnvironmentRevision(value: unknown): number | null {
  const revision = asRecord(asRecord(value).environment).revision
  return Number.isInteger(revision) && Number(revision) >= 0
    ? Number(revision)
    : null
}

export function revisionFromEnvironments(
  value: unknown,
  environmentId: string,
): number | null {
  if (!Array.isArray(value)) return null
  const environment = value.find((entry) => (
    asRecord(entry).environmentId === environmentId
  ))
  const revision = asRecord(environment).revision
  return Number.isInteger(revision) && Number(revision) >= 0
    ? Number(revision)
    : null
}

export function runbookByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
