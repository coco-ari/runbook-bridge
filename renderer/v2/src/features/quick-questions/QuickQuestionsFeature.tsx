import {
  ArrowClockwise,
  CalendarBlank,
  CaretRight,
  Copy,
  FloppyDisk,
  NotePencil,
  Plus,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react"
import { zhCN } from "date-fns/locale"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import {
  getAiOpsV2,
  type IpcResult,
  type PublicError,
  type QuickQuestionRecord,
} from "@/bridge/ai-ops-v2"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Calendar } from "@/components/ui/calendar"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { FeatureToolbar } from "@/components/detail-workspace/FeatureToolbar"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { DirtyLeaveAlertDialog, useDirtyLeaveGuard } from "@/features/environments/DirtyLeaveGuard"
import { focusWorkspaceElement } from "@/lib/workspace-focus"
import { useBusyDialogFocus } from "@/hooks/use-busy-dialog-focus"
import {
  QUICK_QUESTION_MAX_CHARACTERS,
  QUICK_QUESTION_OPENING_MAX_CHARACTERS,
  buildQuickQuestionPreview,
  formatQuickQuestionUpdatedAt,
  normalizeQuickQuestionCollection as normalizeCollection,
  normalizeQuickQuestionOpening as normalizeOpening,
  quickQuestionHasStrictCredential,
  quickQuestionIssue as questionIssue,
  quickQuestionOpeningIssue as openingIssue,
  type QuickQuestionCollection as QuestionCollection,
  type QuickQuestionOpeningState as OpeningState,
} from "@/features/quick-questions/quick-question-model"

class FeatureApiError extends Error {
  readonly code: string

  constructor(error: PublicError) {
    super(error.message)
    this.name = "FeatureApiError"
    this.code = error.code
  }
}

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new FeatureApiError(result.error)
  return result.data
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "快捷提问操作失败。"
}

function parseDateKey(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day
    ? date
    : undefined
}

function formatDateKey(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-")
}

function formatDateLabel(value: string): string {
  return parseDateKey(value)?.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }) ?? "选择日期"
}

export interface QuickQuestionsFeatureProps {
  readonly projectId: string
  readonly environmentId: string
  readonly projectName: string
  readonly environmentName: string
  readonly onDirtyChange: (dirty: boolean) => void
  readonly onSavingChange: (saving: boolean) => void
}

export function QuickQuestionsFeature({
  projectId,
  environmentId,
  projectName,
  environmentName,
  onDirtyChange,
  onSavingChange,
}: QuickQuestionsFeatureProps) {
  const [opening, setOpening] = useState<OpeningState | null>(null)
  const [collection, setCollection] = useState<QuestionCollection>({ items: [], revision: 0 })
  const [question, setQuestion] = useState("")
  const [discoveredDate, setDiscoveredDate] = useState("")
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [loadingOpening, setLoadingOpening] = useState(true)
  const [loadingQuestions, setLoadingQuestions] = useState(true)
  const [busy, setBusy] = useState<"opening" | "question" | "delete" | "copy" | null>(null)
  const deleteDialogRef = useBusyDialogFocus(busy === "delete")
  const [openingReadError, setOpeningReadError] = useState<string | null>(null)
  const [questionsReadError, setQuestionsReadError] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [openingError, setOpeningError] = useState<string | null>(null)
  const [questionError, setQuestionError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [inlineEditor, setInlineEditor] = useState<"opening" | "question" | null>(null)
  const [openingDraft, setOpeningDraft] = useState("")
  const [openingBaseline, setOpeningBaseline] = useState("")
  const [openingEditorRevision, setOpeningEditorRevision] = useState<number | null>(null)
  const [openingStale, setOpeningStale] = useState(false)
  const [questionDraft, setQuestionDraft] = useState("")
  const [questionBaseline, setQuestionBaseline] = useState("")
  const [questionEditorRevision, setQuestionEditorRevision] = useState<number | null>(null)
  const [editingQuestionId, setEditingQuestionId] = useState<string | null>(null)
  const [questionStale, setQuestionStale] = useState(false)
  const [deleteCandidate, setDeleteCandidate] = useState<QuickQuestionRecord | null>(null)
  const openingGenerationRef = useRef(0)
  const questionGenerationRef = useRef(0)
  const scopeEpochRef = useRef(0)
  const editorTriggerRef = useRef<HTMLElement | null>(null)
  const deleteTriggerRef = useRef<HTMLElement | null>(null)
  const deleteInFlightRef = useRef(false)
  const editorReturnTestIdRef = useRef("common-question-add")
  const pendingEditorTransitionRef = useRef<(() => void) | null>(null)
  const editorTransitionPendingRef = useRef(false)

  const editorDirty = inlineEditor === "opening"
    ? openingDraft !== openingBaseline
    : inlineEditor === "question" && questionDraft !== questionBaseline
  const editorLeave = useDirtyLeaveGuard({
    ownerKey: `${projectId}\u0000${environmentId}:quick-questions`,
    dirty: {
      agentAccessDirty: false,
      metadataDirty: false,
      pluginConfigurationDirty: false,
      runbookDirty: false,
      quickQuestionsDirty: editorDirty,
      saveInFlight: busy !== null,
    },
    onBlocked: (message) => toast.warning(message),
    onLeaveApproved: () => {
      const transition = pendingEditorTransitionRef.current
      pendingEditorTransitionRef.current = null
      transition?.()
    },
  })

  useEffect(() => { onDirtyChange(editorDirty) }, [editorDirty, onDirtyChange])
  useEffect(() => { onSavingChange(busy !== null) }, [busy, onSavingChange])
  useEffect(() => () => {
    onDirtyChange(false)
    onSavingChange(false)
  }, [onDirtyChange, onSavingChange])

  useEffect(() => {
    if (!inlineEditor) return
    const frame = requestAnimationFrame(() => {
      const input = document.getElementById(inlineEditor === "opening" ? "quick-opening-editor" : "common-question-editor")
      if (focusWorkspaceElement(input)) input?.scrollIntoView({ block: "nearest", behavior: "auto" })
    })
    return () => cancelAnimationFrame(frame)
  }, [inlineEditor, editingQuestionId])

  const sensitive = quickQuestionHasStrictCredential(question)
  const preview = useMemo(() => buildQuickQuestionPreview({
    opening,
    projectName,
    environmentName,
    question,
    discoveredDate,
  }), [discoveredDate, environmentName, opening, projectName, question])

  const loadOpening = useCallback(async () => {
    const generation = ++openingGenerationRef.current
    setLoadingOpening(true)
    setOpeningReadError(null)
    try {
      const value = unwrap(
        await getAiOpsV2().getQuickQuestionOpening(),
      )
      if (generation !== openingGenerationRef.current) return
      const next = normalizeOpening(value)
      setOpening(next)
    } catch (caught) {
      if (generation === openingGenerationRef.current) setOpeningReadError(errorMessage(caught))
    } finally {
      if (generation === openingGenerationRef.current) setLoadingOpening(false)
    }
  }, [])

  const loadQuestions = useCallback(async () => {
    const generation = ++questionGenerationRef.current
    const requestedScope = `${projectId}\u0000${environmentId}`
    setLoadingQuestions(true)
    setQuestionsReadError(null)
    try {
      const value = unwrap(
        await getAiOpsV2().listQuickQuestions({ projectId, environmentId }),
      )
      if (
        generation !== questionGenerationRef.current
        || requestedScope !== `${projectId}\u0000${environmentId}`
      ) return
      setCollection(normalizeCollection(value))
    } catch (caught) {
      if (generation === questionGenerationRef.current) setQuestionsReadError(errorMessage(caught))
    } finally {
      if (generation === questionGenerationRef.current) setLoadingQuestions(false)
    }
  }, [environmentId, projectId])

  useEffect(() => {
    scopeEpochRef.current += 1
    pendingEditorTransitionRef.current = null
    editorTransitionPendingRef.current = false
    editorTriggerRef.current = null
    setBusy(null)
    setOpening(null)
    setCollection({ items: [], revision: 0 })
    setQuestion("")
    setDiscoveredDate("")
    setDatePickerOpen(false)
    setPreviewOpen(false)
    setOpeningReadError(null)
    setQuestionsReadError(null)
    setCopyError(null)
    setOpeningError(null)
    setQuestionError(null)
    setDeleteError(null)
    setInlineEditor(null)
    setOpeningDraft("")
    setOpeningBaseline("")
    setOpeningEditorRevision(null)
    setQuestionDraft("")
    setQuestionBaseline("")
    setQuestionEditorRevision(null)
    setEditingQuestionId(null)
    setOpeningStale(false)
    setQuestionStale(false)
    setDeleteCandidate(null)
    void loadOpening()
    void loadQuestions()
    return () => {
      scopeEpochRef.current += 1
      openingGenerationRef.current += 1
      questionGenerationRef.current += 1
    }
  }, [environmentId, loadOpening, loadQuestions, projectId])

  useEffect(() => {
    const api = getAiOpsV2()
    return api.onWorkspaceChanged((change) => {
      if (change.type === "quick-question-opening-updated") {
        void loadOpening()
      }
      if (
        change.type === "quick-questions-updated"
        && change.projectId === projectId
        && change.environmentId === environmentId
      ) {
        void loadQuestions()
      }
    })
  }, [environmentId, loadOpening, loadQuestions, projectId])

  useEffect(() => {
    if (inlineEditor === "opening" && openingEditorRevision !== null && opening?.revision !== openingEditorRevision) {
      setOpeningStale(true)
    }
    if (inlineEditor === "question" && questionEditorRevision !== null && collection.revision !== questionEditorRevision) {
      setQuestionStale(true)
    }
  }, [collection.revision, inlineEditor, opening?.revision, openingEditorRevision, questionEditorRevision])

  function restoreEditorFocus() {
    const input = document.getElementById("quick-opening-editor") ?? document.getElementById("common-question-editor")
    if (focusWorkspaceElement(input)) return
    const target = editorTriggerRef.current?.isConnected
      ? editorTriggerRef.current
      : document.querySelector<HTMLElement>(`[data-testid="${editorReturnTestIdRef.current}"]`)
    focusWorkspaceElement(target)
  }

  function closeEditor() {
    setInlineEditor(null)
    setOpeningError(null)
    setQuestionError(null)
    requestAnimationFrame(restoreEditorFocus)
  }

  function requestEditorTransition(transition: () => void) {
    if (busy || editorLeave.open || deleteCandidate || editorTransitionPendingRef.current) return
    editorTransitionPendingRef.current = true
    setDatePickerOpen(false)
    pendingEditorTransitionRef.current = transition
    void editorLeave.requestLeave().then((allowed) => {
      if (!allowed) pendingEditorTransitionRef.current = null
    }).finally(() => {
      editorTransitionPendingRef.current = false
    })
  }

  function openOpeningEditor(trigger: HTMLElement) {
    if (!opening) return
    if (inlineEditor === "opening") {
      focusWorkspaceElement(document.getElementById("quick-opening-editor"))
      return
    }
    requestEditorTransition(() => {
      editorTriggerRef.current = trigger
      editorReturnTestIdRef.current = "quick-opening-edit"
      setOpeningDraft(opening.text)
      setOpeningBaseline(opening.text)
      setOpeningEditorRevision(opening.revision)
      setOpeningError(null)
      setOpeningStale(false)
      setInlineEditor("opening")
    })
  }

  async function saveOpening() {
    if (!opening || busy || inlineEditor !== "opening" || openingStale || openingEditorRevision === null) return
    const epoch = scopeEpochRef.current
    const text = openingDraft.normalize("NFKC").trim()
    const issue = openingIssue(text)
    if (issue) return
    setBusy("opening")
    setOpeningError(null)
    try {
      const value = unwrap(
        await getAiOpsV2().saveQuickQuestionOpening({
          text,
          expectedRevision: openingEditorRevision,
        }),
      )
      if (epoch !== scopeEpochRef.current) return
      const next = normalizeOpening(value)
      setOpening(next)
      setOpeningDraft(next.text)
      setOpeningBaseline(next.text)
      setOpeningEditorRevision(next.revision)
      setOpeningStale(false)
      closeEditor()
      toast.success("开场词已更新，所有环境都会使用。")
    } catch (caught) {
      if (epoch !== scopeEpochRef.current) return
      if (caught instanceof FeatureApiError && caught.code === "CONFIG_REVISION_CONFLICT") {
        setOpeningStale(true)
        setOpeningError(null)
        await loadOpening()
      } else {
        setOpeningError(errorMessage(caught))
      }
    } finally {
      if (epoch === scopeEpochRef.current) setBusy(null)
    }
  }

  async function saveQuestion() {
    if (busy || inlineEditor !== "question" || questionStale || questionEditorRevision === null) return
    const epoch = scopeEpochRef.current
    const text = questionDraft.trim()
    if (questionIssue(text)) return
    setBusy("question")
    setQuestionError(null)
    try {
      const value = unwrap(
        await getAiOpsV2().saveQuickQuestion({
          projectId,
          environmentId,
          ...(editingQuestionId ? { questionId: editingQuestionId } : {}),
          text,
          expectedRevision: questionEditorRevision,
        }),
      )
      if (epoch !== scopeEpochRef.current) return
      setCollection(normalizeCollection(value))
      closeEditor()
      setQuestionDraft("")
      setQuestionBaseline("")
      setEditingQuestionId(null)
      setQuestionStale(false)
      toast.success(editingQuestionId ? "常见问题已更新。" : "已保存为当前环境的常见问题。")
    } catch (caught) {
      if (epoch !== scopeEpochRef.current) return
      if (caught instanceof FeatureApiError && caught.code === "CONFIG_REVISION_CONFLICT") {
        setQuestionStale(true)
        setQuestionError(null)
        await loadQuestions()
      } else {
        setQuestionError(errorMessage(caught))
      }
    } finally {
      if (epoch === scopeEpochRef.current) setBusy(null)
    }
  }

  async function deleteQuestion() {
    if (!deleteCandidate || busy || deleteInFlightRef.current) return
    deleteInFlightRef.current = true
    const epoch = scopeEpochRef.current
    setBusy("delete")
    setDeleteError(null)
    try {
      const value = unwrap(
        await getAiOpsV2().deleteQuickQuestion({
          projectId,
          environmentId,
          questionId: deleteCandidate.questionId,
          expectedRevision: collection.revision,
        }),
      )
      if (epoch !== scopeEpochRef.current) return
      setCollection(normalizeCollection(value))
      setDeleteCandidate(null)
      if (editingQuestionId === deleteCandidate.questionId) closeEditor()
      toast.success("已删除常见问题。")
    } catch (caught) {
      if (epoch !== scopeEpochRef.current) return
      if (caught instanceof FeatureApiError && caught.code === "CONFIG_REVISION_CONFLICT") {
        await loadQuestions()
      }
      setDeleteError(errorMessage(caught))
    } finally {
      deleteInFlightRef.current = false
      if (epoch === scopeEpochRef.current) setBusy(null)
    }
  }

  async function copyQuestion() {
    if (!opening || !question.trim() || busy) return
    const epoch = scopeEpochRef.current
    setBusy("copy")
    setCopyError(null)
    try {
      unwrap(await getAiOpsV2().copyQuickQuestion({
        projectId,
        environmentId,
        text: question.trim(),
        ...(discoveredDate ? { discoveredDate } : {}),
        expectedOpeningRevision: opening.revision,
      }))
      if (epoch !== scopeEpochRef.current) return
      toast.success("已复制，可粘贴到 Agent。")
    } catch (caught) {
      if (epoch !== scopeEpochRef.current) return
      if (caught instanceof FeatureApiError && caught.code === "CONFIG_REVISION_CONFLICT") {
        await loadOpening()
        setCopyError("开场词已更新，预览已刷新。请再次复制。")
      } else {
        setCopyError(errorMessage(caught))
      }
    } finally {
      if (epoch === scopeEpochRef.current) setBusy(null)
    }
  }

  function openQuestionEditor(item?: QuickQuestionRecord, initialText = "", trigger?: HTMLElement) {
    if (inlineEditor === "question" && editingQuestionId === (item?.questionId ?? null) && !initialText) {
      focusWorkspaceElement(document.getElementById("common-question-editor"))
      return
    }
    requestEditorTransition(() => {
      editorTriggerRef.current = trigger ?? null
      editorReturnTestIdRef.current = "common-question-add"
      setQuestionError(null)
      setEditingQuestionId(item?.questionId ?? null)
      setQuestionDraft(item?.text ?? initialText)
      setQuestionBaseline(item?.text ?? "")
      setQuestionEditorRevision(collection.revision)
      setQuestionStale(false)
      setInlineEditor("question")
    })
  }

  const openingValidation = openingIssue(openingDraft)
  const questionValidation = questionIssue(questionDraft)
  const latestEditingQuestion = collection.items.find((item) => item.questionId === editingQuestionId)

  const openingEditor = (
    <Card className="gap-0 py-0 ring-primary/25" data-testid="quick-opening-inline-editor">
      <CardHeader className="border-b border-border/70 px-3 py-3">
        <CardTitle><h3 className="text-sm font-semibold" id="opening-title">编辑 Agent 开场词</h3></CardTitle>
        <p className="text-xs leading-5 text-muted-foreground">该设置对所有环境生效，并且必须明确包含 AI Ops MCP。</p>
      </CardHeader>
      <CardContent className="space-y-3 px-3 py-3">
        <Field data-invalid={Boolean(openingValidation)}>
          <div className="flex items-center justify-between gap-3">
            <FieldLabel htmlFor="quick-opening-editor">开场词</FieldLabel>
            <span className="text-[11px] tabular-nums text-muted-foreground">{Array.from(openingDraft).length} / 500</span>
          </div>
          <Textarea
            aria-describedby={[
              "quick-opening-editor-description",
              openingStale ? "quick-opening-revision-warning" : null,
              openingValidation ? "quick-opening-editor-error" : null,
            ].filter(Boolean).join(" ") || undefined}
            aria-errormessage={openingValidation ? "quick-opening-editor-error" : undefined}
            aria-invalid={Boolean(openingValidation)}
            disabled={busy !== null}
            id="quick-opening-editor"
            maxLength={QUICK_QUESTION_OPENING_MAX_CHARACTERS}
            onChange={(event) => setOpeningDraft(event.target.value)}
            rows={6}
            spellCheck={false}
            value={openingDraft}
          />
          <FieldDescription id="quick-opening-editor-description">保存后对所有环境生效；请保留明确的 AI Ops MCP 使用说明。</FieldDescription>
          <FieldError id="quick-opening-editor-error">{openingValidation}</FieldError>
        </Field>
        {openingStale ? (
          <Alert>
            <WarningCircle />
            <AlertTitle>开场词已有新版本</AlertTitle>
            <AlertDescription id="quick-opening-revision-warning">
              <p>当前草稿已保留，不会自动覆盖新版本。请核对已保存内容后继续。</p>
              <p className="whitespace-pre-wrap break-words rounded-md bg-surface-inset p-2 text-xs">{opening?.text}</p>
              <Button disabled={loadingOpening || busy !== null || !opening || opening.revision === openingEditorRevision} onClick={() => {
                if (!opening) return
                setOpeningEditorRevision(opening.revision)
                setOpeningBaseline(opening.text)
                setOpeningStale(false)
                setOpeningError(null)
              }} size="xs" type="button" variant="outline">采用最新修订，保留草稿</Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {openingError ? (
          <Alert variant="destructive"><WarningCircle weight="fill" /><AlertTitle>开场词未保存</AlertTitle><AlertDescription>{openingError}</AlertDescription></Alert>
        ) : null}
      </CardContent>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 bg-surface-inset/35 px-3 py-3">
        <Button disabled={!opening?.defaultText || busy !== null} onClick={() => setOpeningDraft(opening?.defaultText ?? "")} size="sm" type="button" variant="outline">恢复默认</Button>
        <ButtonGroup aria-label="开场词编辑操作">
          <Button disabled={busy !== null} onClick={() => requestEditorTransition(closeEditor)} size="sm" type="button" variant="outline">取消</Button>
          <Button disabled={Boolean(openingValidation) || openingStale || loadingOpening || busy !== null || !opening} onClick={() => void saveOpening()} size="sm" type="button"><FloppyDisk />{busy === "opening" ? "保存中" : "保存"}</Button>
        </ButtonGroup>
      </div>
    </Card>
  )

  const questionEditor = (
    <Card className="mt-3 gap-0 py-0 ring-primary/25" data-testid="common-question-inline-editor">
      <CardHeader className="border-b border-border/70 px-3 py-3">
        <CardTitle><h4 className="text-sm font-semibold">{editingQuestionId ? "编辑常见问题" : "新增常见问题"}</h4></CardTitle>
        <p className="truncate text-xs text-muted-foreground" title={`${projectName} / ${environmentName}`}>{projectName} / {environmentName}</p>
      </CardHeader>
      <CardContent className="space-y-3 px-3 py-3">
        <Field data-invalid={Boolean(questionValidation)}>
          <div className="flex items-center justify-between gap-3">
            <FieldLabel htmlFor="common-question-editor">问题正文</FieldLabel>
            <span className="text-[11px] tabular-nums text-muted-foreground">{Array.from(questionDraft).length} / 1200</span>
          </div>
          <Textarea
            aria-describedby={[
              "common-question-editor-description",
              questionStale ? "common-question-revision-warning" : null,
              questionValidation ? "common-question-editor-error" : null,
            ].filter(Boolean).join(" ") || undefined}
            aria-errormessage={questionValidation ? "common-question-editor-error" : undefined}
            aria-invalid={Boolean(questionValidation)}
            disabled={busy !== null}
            id="common-question-editor"
            maxLength={QUICK_QUESTION_MAX_CHARACTERS}
            onChange={(event) => setQuestionDraft(event.target.value)}
            rows={6}
            value={questionDraft}
          />
          <FieldDescription id="common-question-editor-description">仅保存到当前项目和环境，不会改变其他环境的常见问题。</FieldDescription>
          <FieldError id="common-question-editor-error">{questionValidation}</FieldError>
        </Field>
        {questionStale ? (
          <Alert>
            <WarningCircle />
            <AlertTitle>常见问题列表已有新版本</AlertTitle>
            <AlertDescription id="common-question-revision-warning">
              <p>{editingQuestionId && !latestEditingQuestion ? "原问题已被移除。草稿仍保留，可另存为当前环境的新问题。" : "当前草稿已保留，不会自动覆盖新版本。请核对已保存内容后继续。"}</p>
              {latestEditingQuestion ? <p className="whitespace-pre-wrap break-words rounded-md bg-surface-inset p-2 text-xs">{latestEditingQuestion.text}</p> : null}
              <Button disabled={loadingQuestions || busy !== null || collection.revision === questionEditorRevision} onClick={() => {
                setQuestionEditorRevision(collection.revision)
                setQuestionBaseline(latestEditingQuestion?.text ?? "")
                if (editingQuestionId && !latestEditingQuestion) setEditingQuestionId(null)
                setQuestionStale(false)
                setQuestionError(null)
              }} size="xs" type="button" variant="outline">{editingQuestionId && !latestEditingQuestion ? "另存为新问题" : "采用最新修订，保留草稿"}</Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {questionError ? (
          <Alert variant="destructive"><WarningCircle weight="fill" /><AlertTitle>常见问题未保存</AlertTitle><AlertDescription>{questionError}</AlertDescription></Alert>
        ) : null}
      </CardContent>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 bg-surface-inset/35 px-3 py-3">
        {editingQuestionId ? (
          <Button disabled={busy !== null || !latestEditingQuestion} onClick={() => {
            if (!latestEditingQuestion) return
            setDeleteError(null)
            setDeleteCandidate(latestEditingQuestion)
          }} size="sm" type="button" variant="outline"><Trash className="text-danger" />删除</Button>
        ) : <span className="text-xs text-muted-foreground">仅保存在当前环境</span>}
        <ButtonGroup aria-label="常见问题编辑操作">
          <Button disabled={busy !== null} onClick={() => requestEditorTransition(closeEditor)} size="sm" type="button" variant="outline">取消</Button>
          <Button disabled={Boolean(questionValidation) || questionStale || loadingQuestions || busy !== null} onClick={() => void saveQuestion()} size="sm" type="button"><FloppyDisk />{busy === "question" ? "保存中" : "保存"}</Button>
        </ButtonGroup>
      </div>
    </Card>
  )

  return (
    <section
      aria-labelledby="quick-questions-title"
      className="flex min-h-0 min-w-0 flex-1 flex-col @container/quick-questions"
      data-feature="quick-questions"
    >
      <FeatureToolbar
        className="[&>div]:flex-row [&>div]:items-center [&>div>div]:w-auto"
        actions={(
          <Button
            aria-label="刷新快捷提问"
            disabled={loadingOpening || loadingQuestions || busy !== null}
            onClick={() => {
              void loadOpening()
              void loadQuestions()
            }}
            size="icon-xs"
            variant="ghost"
          >
            <ArrowClockwise className={loadingOpening || loadingQuestions ? "animate-spin" : ""} />
          </Button>
        )}
        description="描述问题，复制后粘贴到 Agent 开始排查。"
        title={`${projectName} / ${environmentName} 快捷提问`}
        titleId="quick-questions-title"
      />

      <ScrollArea className="min-h-0 flex-1">
        <div className="grid min-w-0 items-start gap-6 p-1 pb-2 pr-2 @4xl/quick-questions:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="min-w-0 space-y-4">
            <section className="space-y-3" data-testid="quick-question-composer">
              <Field className="gap-2.5">
                <div className="flex items-center justify-between gap-3">
                  <FieldLabel className="text-base font-semibold" htmlFor="quick-question-input">要排查什么问题？</FieldLabel>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {Array.from(question).length} / 1200
                  </span>
                </div>
                <Textarea
                  aria-describedby="quick-question-input-description"
                  className="min-h-36 field-sizing-fixed resize-y leading-6"
                  id="quick-question-input"
                  maxLength={QUICK_QUESTION_MAX_CHARACTERS}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="例如：这个订单为什么一直待支付？"
                  rows={5}
                  value={question}
                />
                <FieldDescription className="text-xs" id="quick-question-input-description">
                  可补充错误原文、接口地址或相关现象。
                </FieldDescription>
              </Field>

              {sensitive && (
                <Alert className="border-warning/30 bg-warning/[0.055] text-warning">
                  <WarningCircle weight="fill" />
                  <AlertTitle>检测到敏感内容</AlertTitle>
                  <AlertDescription className="text-warning/90">
                    可能包含登录凭据、密码或私钥。不能保存为常见问题，复制时后台仍会执行最终脱敏。
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <Field className="w-auto flex-wrap gap-x-3 gap-y-1.5" orientation="horizontal">
                  <FieldLabel className="flex-none! text-xs text-muted-foreground" htmlFor="quick-question-date">发现日期 <span className="font-normal">（可选）</span></FieldLabel>
                  <Popover onOpenChange={setDatePickerOpen} open={datePickerOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        aria-describedby="quick-question-date-description"
                        className="w-auto justify-start text-left font-normal data-[empty=true]:text-muted-foreground"
                        data-empty={!discoveredDate}
                        id="quick-question-date"
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <CalendarBlank aria-hidden="true" />
                        {formatDateLabel(discoveredDate)}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-auto gap-0 p-0">
                      <Calendar
                        autoFocus
                        locale={zhCN}
                        mode="single"
                        onSelect={(date) => {
                          if (!date) return
                          setDiscoveredDate(formatDateKey(date))
                          setDatePickerOpen(false)
                        }}
                        selected={parseDateKey(discoveredDate)}
                      />
                      <div className="flex items-center justify-between border-t border-border/70 px-2 py-1.5">
                        <span className="text-xs text-muted-foreground">复制时仅显示月、日</span>
                        <Button
                          disabled={!discoveredDate}
                          onClick={() => {
                            setDiscoveredDate("")
                            setDatePickerOpen(false)
                          }}
                          size="xs"
                          type="button"
                          variant="ghost"
                        >
                          清除日期
                        </Button>
                      </div>
                    </PopoverContent>
                  </Popover>
                  <FieldDescription className="sr-only" id="quick-question-date-description">可选，复制时仅显示月份和日期。</FieldDescription>
                </Field>

                <div aria-label="快捷提问操作" className="ml-auto flex flex-wrap items-center justify-end gap-2" role="group">
                  <Button
                    className="text-muted-foreground"
                    disabled={!question.trim() || sensitive || loadingQuestions || busy !== null}
                    onClick={(event) => openQuestionEditor(undefined, question.trim(), event.currentTarget)}
                    size="sm"
                    variant="ghost"
                  >
                    <FloppyDisk />
                    保存为常见问题
                  </Button>
                  <Button
                    data-testid="quick-question-copy"
                    disabled={!question.trim() || !opening || busy !== null}
                    onClick={() => void copyQuestion()}
                    size="sm"
                  >
                    <Copy />
                    {busy === "copy" ? "复制中" : "复制到剪贴板"}
                  </Button>
                </div>
              </div>
              {copyError ? <Alert variant="destructive"><WarningCircle /><AlertTitle>复制未完成</AlertTitle><AlertDescription>{copyError}</AlertDescription></Alert> : null}
            </section>

            <section aria-labelledby="quick-preview-title">
              <Collapsible onOpenChange={setPreviewOpen} open={previewOpen}>
                <h3 id="quick-preview-title">
                  <CollapsibleTrigger asChild>
                    <Button
                      className="h-auto w-full justify-start gap-2 px-0 py-2 text-muted-foreground hover:bg-transparent hover:text-foreground"
                      data-testid="quick-preview-toggle"
                      variant="ghost"
                    >
                      <CaretRight className={previewOpen ? "rotate-90" : ""} />
                      <span className="text-xs font-medium">最终复制内容</span>
                      <span className="ml-auto text-[11px] font-normal">{previewOpen ? "收起预览" : "展开预览"}</span>
                    </Button>
                  </CollapsibleTrigger>
                </h3>
                <CollapsibleContent>
                  <pre className="mt-1 whitespace-pre-wrap break-words rounded-md border border-border/70 bg-surface-inset/55 p-3 text-xs leading-5" data-testid="quick-question-preview" tabIndex={0}>
                    {preview}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            </section>

            <section aria-labelledby="opening-title">
              {inlineEditor === "opening" ? openingEditor : <Item className="flex-nowrap items-start gap-2 border-0 border-t border-border/70 rounded-none px-0 pb-0 pt-3" size="sm">
                <ItemContent>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <ItemTitle asChild><h3 className="text-xs text-muted-foreground" id="opening-title">Agent 开场词</h3></ItemTitle>
                    <span className="text-[11px] text-muted-foreground">所有环境通用</span>
                  </div>
                  {loadingOpening ? (
                    <Skeleton className="mt-1 h-4 w-full" />
                  ) : (
                    <ItemDescription className="mt-0.5 line-clamp-1 break-all text-xs leading-5">
                      {opening?.text || "开场词不可用。"}
                    </ItemDescription>
                  )}
                </ItemContent>
                <ItemActions>
                  <Button
                    aria-label="编辑 Agent 开场词"
                    className="text-muted-foreground"
                    data-testid="quick-opening-edit"
                    disabled={!opening || loadingOpening || busy !== null}
                    onClick={(event) => openOpeningEditor(event.currentTarget)}
                    size="xs"
                    variant="ghost"
                  >
                    <NotePencil />
                    编辑
                  </Button>
                </ItemActions>
              </Item>}
              {openingReadError ? <Alert className="mt-3" variant="destructive"><WarningCircle /><AlertTitle>开场词读取失败</AlertTitle><AlertDescription>{openingReadError}</AlertDescription></Alert> : null}
            </section>
            {inlineEditor === "question" ? questionEditor : null}
          </div>

          <section aria-labelledby="common-questions-title" className="min-w-0 rounded-lg bg-surface-inset/45 p-3 @4xl/quick-questions:p-4" data-testid="common-question-library">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 id="common-questions-title" className="text-sm font-semibold">我的常见问题</h3>
                <p className="mt-1 text-xs text-muted-foreground">仅当前项目与环境</p>
              </div>
              <Button
                data-testid="common-question-add"
                disabled={loadingQuestions || busy !== null}
                onClick={(event) => openQuestionEditor(undefined, "", event.currentTarget)}
                size="xs"
                variant="ghost"
              >
                <Plus />
                新增
              </Button>
            </div>
            {questionsReadError ? <Alert className="mt-3" variant="destructive"><WarningCircle /><AlertTitle>常见问题读取失败</AlertTitle><AlertDescription>{questionsReadError}</AlertDescription></Alert> : null}
            {loadingQuestions ? (
              <div className="mt-3 space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : questionsReadError && collection.items.length === 0 ? null : collection.items.length === 0 ? (
              <Empty className="items-start px-0 py-4 text-left">
                <EmptyHeader className="items-start gap-1">
                  <EmptyTitle className="text-xs font-normal text-muted-foreground">还没有常见问题</EmptyTitle>
                  <EmptyDescription className="text-xs">写好问题后，保存到这里重复使用。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ItemGroup className="mt-3 gap-1">
                {collection.items.map((item) => (
                  <Item
                    className="min-w-0 flex-nowrap gap-1 border-0 p-0 hover:bg-surface-hover/60"
                    key={item.questionId}
                    role="listitem"
                    size="xs"
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          className="h-auto min-w-0 flex-1 justify-start rounded-none px-2.5 py-2 text-left font-normal hover:bg-transparent focus-visible:ring-inset"
                          onClick={() => {
                            setQuestion(item.text)
                            const input = document.getElementById("quick-question-input")
                            if (focusWorkspaceElement(input)) input?.scrollIntoView({ block: "nearest", behavior: "auto" })
                          }}
                          variant="ghost"
                        >
                          <ItemContent asChild>
                            <span>
                              <ItemTitle asChild className="line-clamp-2 w-full whitespace-normal break-all text-xs font-medium leading-5">
                                <span>{item.text}</span>
                              </ItemTitle>
                              <ItemDescription asChild className="text-[10px]">
                                <span>{formatQuickQuestionUpdatedAt(item.updatedAt)}</span>
                              </ItemDescription>
                            </span>
                          </ItemContent>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent className="whitespace-normal break-words" side="top">
                        点击填入问题；可展开预览查看完整内容
                      </TooltipContent>
                    </Tooltip>
                    <ItemActions asChild>
                      <div className="mr-1 shrink-0 gap-0.5" aria-label={`${item.text}操作`} role="group">
                        <Button
                          aria-label={`编辑常见问题：${item.text}`}
                          disabled={busy !== null}
                          onClick={(event) => openQuestionEditor(item, "", event.currentTarget)}
                          size="icon-xs"
                          variant="ghost"
                        >
                          <NotePencil />
                        </Button>
                        <Button
                          aria-label={`删除常见问题：${item.text}`}
                          disabled={busy !== null}
                          onClick={(event) => {
                            deleteTriggerRef.current = event.currentTarget
                            setDeleteError(null)
                            setDeleteCandidate(item)
                          }}
                          size="icon-xs"
                          variant="ghost"
                        >
                          <Trash />
                        </Button>
                      </div>
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            )}
          </section>
        </div>
      </ScrollArea>

      <AlertDialog
        open={Boolean(deleteCandidate)}
        onOpenChange={(open) => {
          if (!open && busy !== "delete" && !deleteInFlightRef.current) {
            setDeleteCandidate(null)
            setDeleteError(null)
          }
        }}
      >
        <AlertDialogContent
          ref={deleteDialogRef}
          aria-busy={busy === "delete" || undefined}
          onEscapeKeyDown={(event) => { if (busy === "delete" || deleteInFlightRef.current) event.preventDefault() }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const trigger = deleteTriggerRef.current
            requestAnimationFrame(() => requestAnimationFrame(() => {
              if (!focusWorkspaceElement(trigger)) {
                focusWorkspaceElement(document.querySelector<HTMLElement>('[data-testid="common-question-add"]'))
              }
            }))
          }}
        >
          <AlertDialogHeader>
            <AlertDialogMedia className="text-danger"><Trash /></AlertDialogMedia>
            <AlertDialogTitle>删除常见问题</AlertDialogTitle>
            <AlertDialogDescription>
              此操作无法撤销。问题正文不会写入日志或确认消息。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <Alert variant="destructive">
              <WarningCircle weight="fill" />
              <AlertTitle>常见问题未删除</AlertTitle>
              <AlertDescription>{deleteError}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "delete"}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy === "delete"}
              onClick={(event) => {
                event.preventDefault()
                void deleteQuestion()
              }}
              variant="destructive"
            >
              {busy === "delete" ? "删除中" : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <DirtyLeaveAlertDialog controller={editorLeave} onCloseAutoFocus={(event) => {
        event.preventDefault()
        requestAnimationFrame(() => requestAnimationFrame(restoreEditorFocus))
      }} />
    </section>
  )
}
