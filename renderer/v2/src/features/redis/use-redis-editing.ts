import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { AiOpsV2Api, IpcResult, PluginScope, RedisEditData, RedisEditPlan, RedisEditStatus } from "@/bridge/ai-ops-v2"
import type { RedisTab } from "./use-redis-workspace"

export interface RedisDraft {
  key: string; value: string; format: "text" | "json"; expiry: "keep" | "persistent" | "relative"; duration: string; unit: string
  creating: boolean; session: RedisEditData | null; plan: RedisEditPlan | null; busy: boolean; phase?: "prepare" | "commit" | "check" | "read" | undefined; stale: boolean; uncertain: boolean; error: string
}
const unwrap = <T,>(value: IpcResult<T>): T => { if (!value.ok) throw Object.assign(new Error(value.error.message), {code:value.error.code}); return value.data }
const blank = (key: string, creating: boolean): RedisDraft => ({ key, value:"", format:"text", expiry:creating ? "persistent" : "keep", duration:"1", unit:"3600000", creating, session:null, plan:null, busy:false, stale:false, uncertain:false, error:"" })
export function useRedisEditing(api: AiOpsV2Api, scope: PluginScope, connected: boolean, connectionEpoch: number, onDirtyChange: (dirty: boolean) => void, saved: (id: string, key: string, removed: boolean, summary?: string) => void) {
  const [drafts, setDrafts] = useState<Record<string, RedisDraft>>({})
  const ref = useRef(drafts)
  const alive = useRef(true)
  const currentEpoch = useRef(connectionEpoch)
  const isConnected = useRef(connected)
  currentEpoch.current = connectionEpoch; isConnected.current = connected
  function capture() {
    const epoch = currentEpoch.current
    return () => alive.current && isConnected.current && epoch === currentEpoch.current
  }
  const [opening, setOpening] = useState<{id: string; mode: "update" | "delete"} | null>(null)
  const [notice, setNotice] = useState("")
  const [deletionVisible, setDeletionVisible] = useState(false)
  const [verification, setVerification] = useState<{id: string; key: string; exists: boolean; type: string; value: string; complete: boolean; deletion: boolean} | null>(null)
  const openingRef = useRef(false)
  const [deletion, storeDeletion] = useState<{id: string; patternId: string; session: RedisEditData; plan: RedisEditPlan | null; busy: boolean; phase?: "prepare" | "commit" | "check" | "read" | undefined; uncertain: boolean; error: string} | null>(null)
  const deletionRef = useRef(deletion)
  deletionRef.current = deletion
  function setDeletion(value: typeof deletion) { deletionRef.current = value; storeDeletion(value) }
  const [pending, setPending] = useState<{action: () => void; ids: readonly string[]} | null>(null)
  const [review, setReview] = useState<{id: string; session: RedisEditData} | null>(null)
  const reviewRef = useRef(review)
  reviewRef.current = review
  function update(id: string, patch: Partial<RedisDraft>) { const draft = ref.current[id]; if (!draft) return; ref.current = {...ref.current, [id]:{...draft,...patch}}; setDrafts(ref.current) }
  function release(session: RedisEditData | null | undefined) { if (session) void api.redisEditRelease({...scope,editId:session.editId}).catch(() => {}) }
  function discard(id: string) { release(ref.current[id]?.session); const next = {...ref.current}; delete next[id]; ref.current = next; setDrafts(next) }
  function create(id: string) { ref.current = {...ref.current,[id]:blank("",true)}; setDrafts(ref.current) }
  async function open(tab: RedisTab, mode: "update" | "delete") {
    if (openingRef.current || !isConnected.current || tab.stale) return
    if (deletionRef.current?.uncertain) { setDeletionVisible(true); return }
    openingRef.current = true; setOpening({id:tab.id,mode}); setNotice("")
    const epoch = currentEpoch.current
    try {
      const session = unwrap(await api.redisEditOpen({...scope,patternId:tab.patternId,key:tab.key,mode}))
      if (!alive.current || epoch !== currentEpoch.current || !isConnected.current) { release(session); return }
      if (mode === "delete") { setDeletion({id:tab.id,patternId:tab.patternId,session,plan:null,busy:false,uncertain:false,error:""}); setDeletionVisible(true) }
      else {
        let format: "text" | "json" = "text"
        try { JSON.parse(session.value ?? ""); format = "json" } catch { /* 普通文本保持原样。 */ }
        ref.current = {...ref.current,[tab.id]:{...blank(tab.key,false),session,value:session.value ?? "",format}}
        setDrafts(ref.current)
      }
    } catch (error) { if (alive.current) toast.error(error instanceof Error ? error.message : "无法打开编辑") }
    finally { openingRef.current = false; if (alive.current) setOpening(null) }
  }
  function accept(id: string, status: RedisEditStatus) {
    if (status.status === "success" && status.result) {
      const summary = `${status.result.mode === "create" ? "已新增" : status.result.mode === "delete" ? "已删除" : "已修改"} Key：${status.result.key}` + (status.result.auditWarning ? "；操作记录未能写入。" : "")
      discard(id); setNotice(summary); saved(id,status.result.key,status.result.mode === "delete",summary)
      toast.success(summary)
    } else update(id,{uncertain:status.status === "unknown" || status.status === "running",stale:status.status === "failed",error:status.error?.message ?? "正在确认保存结果，请稍候。"})
  }
  async function save(id: string, patternId: string) {
    const draft = ref.current[id]
    if (!draft || draft.busy || !isConnected.current || draft.uncertain) return
    update(id,{busy:true,phase:"prepare",error:""})
    const isCurrent = capture()
    let attempted = false
    try {
      let session = draft.session
      if (draft.creating && !draft.stale && (!session || session.key !== draft.key)) {
        release(session)
        session = unwrap(await api.redisEditOpen({...scope,patternId,key:draft.key,mode:"create"}))
        if (!isCurrent()) { release(session); return }
        update(id,{session})
      }
      if (draft.stale) {
        const fresh = unwrap(await api.redisEditOpen({...scope,patternId,key:draft.key,mode:draft.creating ? "create" : "update"}))
        if (!isCurrent()) { release(fresh); return }
        if (!draft.creating && fresh.value !== session?.value) { setReview({id,session:fresh}); return }
        release(session); session = fresh
        update(id,{session,plan:null,stale:false,error:""})
      }
      if (!session) throw new Error("请重新读取并核对内容。")
      const plan = unwrap(await api.redisEditPrepare({...scope,editId:session.editId,value:draft.value,format:draft.format,expiry:draft.expiry === "relative" ? {mode:"relative",milliseconds:Number(draft.duration)*Number(draft.unit)} : {mode:draft.expiry}}))
      if (!isCurrent()) return
      update(id,{plan,phase:"commit"}); attempted = true
      const status = unwrap(await api.redisEditCommit({...scope,editId:session.editId,planId:plan.planId}))
      if (alive.current) accept(id,status)
    } catch (error) {
      const code = (error as {code?: string}).code
      if (alive.current) update(id,{error:(error instanceof Error ? error.message : "保存失败") + (attempted ? "。正在自动确认保存结果。" : ""),uncertain:attempted || draft.uncertain,stale:!isCurrent() || draft.stale || (!attempted && ["REDIS_EDIT_STALE","REDIS_EDIT_CONFLICT"].includes(code ?? ""))})
    } finally { if (alive.current) update(id,{busy:false,phase:undefined}) }
    if (alive.current && ref.current[id]?.uncertain) await verify(id,patternId)
  }
  async function confirmDelete() {
    const item = deletionRef.current
    if (!item || item.busy || !isConnected.current || item.uncertain) return
    const isCurrent = capture()
    setDeletion({...item,busy:true,phase:item.plan ? "commit" : "prepare",error:""})
    let plan = item.plan, attempted = false
    try {
      if (!plan) plan = unwrap(await api.redisEditPrepare({...scope,editId:item.session.editId}))
      if (!isCurrent()) {
        release(item.session); setDeletion(null); setDeletionVisible(false); return
      }
      setDeletion({...item,plan,busy:true,phase:"commit",error:""})
      attempted = true
      const payload = {...scope,editId:item.session.editId,planId:plan.planId}
      const status = unwrap(await api.redisEditCommit(payload))
      if (!alive.current) return
      if (status.status === "success") { const summary = "已删除 Key：" + item.session.key + (status.result?.auditWarning ? "；操作记录未能写入。" : ""); release(item.session); discard(item.id); saved(item.id,item.session.key,true,summary); setNotice(summary); setDeletion(null); setDeletionVisible(false); toast.success(summary) }
      else setDeletion({...item,plan,busy:false,uncertain:status.status === "unknown" || status.status === "running",error:status.error?.message ?? "删除仍在进行，请检查状态。"})
    } catch (error) { if (alive.current && (isCurrent() || attempted)) setDeletion({...item,plan,busy:false,uncertain:attempted,error:(error instanceof Error ? error.message : "删除失败") + (attempted ? "。正在自动确认删除结果。" : "")}) }
    finally {
      if (alive.current && !isCurrent() && !attempted && deletionRef.current?.session === item.session) {
        release(item.session); setDeletion(null); setDeletionVisible(false)
      }
    }
    if (alive.current && deletionRef.current?.uncertain) await verify(item.id,item.patternId,true)
  }
  function cancelDelete() { const item = deletionRef.current; if (item?.busy) return; setDeletionVisible(false); if (!item?.uncertain) { release(item?.session); setDeletion(null) } }
  const busy = Boolean(opening) || Object.values(drafts).some(draft => draft.busy) || Boolean(deletion?.busy)
  function protect(action: () => void, ids = Object.keys(ref.current), preserveDrafts = false) {
    if (openingRef.current || Object.values(ref.current).some(draft => draft.busy) || deletionRef.current?.busy) { toast.info("正在处理数据，请等待结果。"); return }
    if (deletionRef.current?.uncertain) { setDeletionVisible(true); return }
    if (ids.some(id => ref.current[id]?.uncertain)) { toast.info("保存结果尚未确认，请点击“重新确认结果”；草稿已保留。"); return }
    const dirty = preserveDrafts ? [] : ids.filter(id => ref.current[id])
    if (dirty.length) setPending({action,ids:dirty}); else action()
  }
  async function verify(id: string, patternId: string, remove = false) {
    const draft = ref.current[id], item = deletionRef.current
    if (!isConnected.current || (remove ? !item?.uncertain || item.busy : !draft?.uncertain || draft.busy)) return
    const key = remove ? item!.session.key : draft!.key
    const epoch = currentEpoch.current
    if (remove) setDeletion({...item!,busy:true,phase:"read",error:""})
    else update(id,{busy:true,phase:"read",error:""})
    try {
      const session = remove ? item!.session : draft!.session
      const plan = remove ? item!.plan : draft!.plan
      if (!session || !plan) throw new Error("未找到本次提交记录，请保留草稿并重新查询核实。")
      let status: RedisEditStatus | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!alive.current || epoch !== currentEpoch.current || !isConnected.current) return
        try { status = unwrap(await api.redisEditStatus({...scope,editId:session.editId,planId:plan.planId})) }
        catch (error) { if (attempt === 2) throw error }
        if (status && status.status !== "running" && status.status !== "prepared") break
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve,400))
      }
      if (!alive.current || epoch !== currentEpoch.current || !isConnected.current) return
      if (!status || status.status === "running" || status.status === "prepared") throw new Error("操作仍在处理中，稍后点击“重新确认结果”即可，草稿已保留。")
      if (status.status === "success" || status.status === "failed") {
        if (!remove) accept(id,status)
        else if (status.status === "success") {
          const summary = "已删除 Key：" + key + (status.result?.auditWarning ? "；操作记录未能写入。" : "")
          release(session); discard(id); saved(id,key,true,summary); setNotice(summary); setDeletion(null); setDeletionVisible(false); toast.success(summary)
        } else setDeletion({...item!,busy:false,uncertain:false,error:status.error?.message ?? "删除未成功，请重新打开删除确认。"})
        return
      }
      const payload = {...scope,patternId,key}
      if (!alive.current || epoch !== currentEpoch.current || !isConnected.current) return
      const info = unwrap(await api.redisWorkspaceInspect(payload))
      if (!alive.current || epoch !== currentEpoch.current || !isConnected.current) return
      const content = info.exists && info.type === "string" ? unwrap(await api.redisWorkspaceRead({...payload,expectedType:info.type})) : null
      if (!alive.current || epoch !== currentEpoch.current || !isConnected.current) throw new Error("连接已变化，请重新核实。")
      setVerification({id,key,exists:content?.exists ?? info.exists,type:info.type,value:content?.value?.text ?? "",complete:Boolean(content?.value && content.value.text !== null && !content.value.truncated),deletion:remove})
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取核实失败，请重试。"
      if (remove && deletionRef.current) setDeletion({...deletionRef.current,error:message})
      else update(id,{error:message})
    } finally {
      if (alive.current) {
        if (remove && deletionRef.current) setDeletion({...deletionRef.current,busy:false,phase:undefined})
        else update(id,{busy:false,phase:undefined})
      }
    }
  }
  function finishVerification(acknowledged: boolean) {
    if (!verification) return
    if (acknowledged) {
      if (verification.deletion) { release(deletionRef.current?.session); setDeletion(null); setDeletionVisible(false) }
      discard(verification.id)
      const summary = "已结束结果核实，请以当前服务器数据为准：" + verification.key
      setNotice(summary); saved(verification.id,verification.key,!verification.exists,summary)
    }
    setVerification(null)
  }
  function finishReview(accept: boolean) {
    const item = reviewRef.current
    if (!item) return
    if (accept && isConnected.current) { release(ref.current[item.id]?.session); update(item.id,{session:item.session,plan:null,stale:false,uncertain:false,error:""}) }
    else release(item.session)
    setReview(null)
  }
  useEffect(() => { onDirtyChange(Object.keys(drafts).length > 0 || Boolean(opening) || Boolean(deletion)); }, [drafts, opening, deletion, onDirtyChange])
  useEffect(() => {
    setVerification(null)
    release(reviewRef.current?.session); setReview(null)
    const item = deletionRef.current
    if (item && !item.uncertain) {
      if (item.busy && item.phase === "commit") {
        setDeletion({...item,uncertain:true,error:"连接已变化，删除结果待核实，请勿重复删除。"})
      } else if (!item.busy) {
        release(item.session); setDeletion(null); setDeletionVisible(false)
      } else setDeletionVisible(false)
    }
    for (const id of Object.keys(ref.current)) update(id,{stale:true,error:"连接已变化，草稿已保留。连接恢复后点击保存，将自动检查当前内容。"})
    // 连接代次变化后保留本地输入，旧授权不再使用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, connectionEpoch])
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; Object.values(ref.current).forEach(draft => release(draft.session)); release(deletionRef.current?.session); release(reviewRef.current?.session); onDirtyChange(false) }
    // 所有草稿和授权只属于本次工作区会话。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return {drafts,update,discard,create,open,save,busy,opening,notice,verification,verify,finishVerification,deletionVisible,resumeDeletion:()=>setDeletionVisible(true),deletion,confirmDelete,cancelDelete,protect,pending,cancelPending:()=>setPending(null),confirmPending:()=>{const item=pending;if(item){item.ids.forEach(discard);setPending(null);item.action()}},review,finishReview}
}
