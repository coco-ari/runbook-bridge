import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { AiOpsV2Api, IpcResult, PluginScope, RedisEditData, RedisEditPlan, RedisEditStatus } from "@/bridge/ai-ops-v2"
import type { RedisTab } from "./use-redis-workspace"

export interface RedisDraft {
  key: string; value: string; format: "text" | "json"; expiry: "keep" | "persistent" | "relative"; duration: string; unit: string
  creating: boolean; session: RedisEditData | null; plan: RedisEditPlan | null; busy: boolean; stale: boolean; uncertain: boolean; error: string
}
const unwrap = <T,>(value: IpcResult<T>): T => { if (!value.ok) throw Object.assign(new Error(value.error.message), {code:value.error.code}); return value.data }
const blank = (key: string, creating: boolean): RedisDraft => ({ key, value:"", format:"text", expiry:creating ? "persistent" : "keep", duration:"1", unit:"3600000", creating, session:null, plan:null, busy:false, stale:false, uncertain:false, error:"" })
export function useRedisEditing(api: AiOpsV2Api, scope: PluginScope, connected: boolean, connectionEpoch: number, onDirtyChange: (dirty: boolean) => void, saved: (id: string, key: string, removed: boolean) => void) {
  const [drafts, setDrafts] = useState<Record<string, RedisDraft>>({})
  const ref = useRef(drafts)
  const alive = useRef(true)
  const currentEpoch = useRef(connectionEpoch)
  const isConnected = useRef(connected)
  currentEpoch.current = connectionEpoch; isConnected.current = connected
  const [opening, setOpening] = useState(false)
  const openingRef = useRef(false)
  const [deletion, setDeletion] = useState<{id: string; session: RedisEditData; plan: RedisEditPlan | null; busy: boolean; uncertain: boolean; error: string} | null>(null)
  const deletionRef = useRef(deletion)
  deletionRef.current = deletion
  const [pending, setPending] = useState<{action: () => void; ids: readonly string[]} | null>(null)
  const [review, setReview] = useState<{id: string; session: RedisEditData} | null>(null)
  const reviewRef = useRef(review)
  reviewRef.current = review
  function update(id: string, patch: Partial<RedisDraft>) { const draft = ref.current[id]; if (!draft) return; ref.current = {...ref.current, [id]:{...draft,...patch}}; setDrafts(ref.current) }
  function release(session: RedisEditData | null | undefined) { if (session) void api.redisEditRelease({...scope,editId:session.editId}).catch(() => {}) }
  function discard(id: string) { release(ref.current[id]?.session); const next = {...ref.current}; delete next[id]; ref.current = next; setDrafts(next) }
  function create(id: string) { ref.current = {...ref.current,[id]:blank("",true)}; setDrafts(ref.current) }
  async function open(tab: RedisTab, mode: "update" | "delete") {
    if (openingRef.current || !isConnected.current) return
    openingRef.current = true; setOpening(true)
    const epoch = currentEpoch.current
    try {
      const session = unwrap(await api.redisEditOpen({...scope,patternId:tab.patternId,key:tab.key,mode}))
      if (!alive.current || epoch !== currentEpoch.current || !isConnected.current) { release(session); return }
      if (mode === "delete") setDeletion({id:tab.id,session,plan:null,busy:false,uncertain:false,error:""})
      else {
        let format: "text" | "json" = "text"
        try { JSON.parse(session.value ?? ""); format = "json" } catch { /* 普通文本保持原样。 */ }
        ref.current = {...ref.current,[tab.id]:{...blank(tab.key,false),session,value:session.value ?? "",format}}
        setDrafts(ref.current)
      }
    } catch (error) { if (alive.current) toast.error(error instanceof Error ? error.message : "无法打开编辑") }
    finally { openingRef.current = false; if (alive.current) setOpening(false) }
  }
  function accept(id: string, status: RedisEditStatus) {
    if (status.status === "success" && status.result) {
      discard(id); saved(id,status.result.key,status.result.mode === "delete")
      toast.success(status.result.auditWarning ? "数据已保存，但操作记录未能写入。" : status.result.mode === "delete" ? "Key 已删除" : "Key 已保存")
    } else update(id,{uncertain:status.status === "unknown" || status.status === "running",stale:status.status === "failed",error:status.error?.message ?? "保存仍在进行，请检查状态，不要重复提交。"})
  }
  async function save(id: string, patternId: string, checkOnly = false) {
    const draft = ref.current[id]
    if (!draft || draft.busy || (!checkOnly && (!isConnected.current || draft.stale || draft.uncertain))) return
    update(id,{busy:true,error:""})
    let attempted = false
    try {
      let session = draft.session
      if (checkOnly) {
        if (!session || !draft.plan) return
        accept(id,unwrap(await api.redisEditStatus({...scope,editId:session.editId,planId:draft.plan.planId}))); return
      }
      if (draft.creating && (!session || session.key !== draft.key)) {
        release(session)
        session = unwrap(await api.redisEditOpen({...scope,patternId,key:draft.key,mode:"create"}))
        if (!alive.current) { release(session); return }
        update(id,{session})
      }
      if (!session) throw new Error("请重新读取并核对内容。")
      const plan = unwrap(await api.redisEditPrepare({...scope,editId:session.editId,value:draft.value,format:draft.format,expiry:draft.expiry === "relative" ? {mode:"relative",milliseconds:Number(draft.duration)*Number(draft.unit)} : {mode:draft.expiry}}))
      update(id,{plan}); attempted = true
      const status = unwrap(await api.redisEditCommit({...scope,editId:session.editId,planId:plan.planId}))
      if (alive.current) accept(id,status)
    } catch (error) {
      const code = (error as {code?: string}).code
      if (alive.current) update(id,{error:(error instanceof Error ? error.message : "保存失败") + (attempted ? "。请检查保存状态，勿重复提交。" : ""),uncertain:attempted || checkOnly || draft.uncertain,stale:draft.stale || (!attempted && ["REDIS_EDIT_STALE","REDIS_EDIT_CONFLICT"].includes(code ?? ""))})
    } finally { if (alive.current) update(id,{busy:false}) }
  }
  async function confirmDelete(checkOnly = false) {
    const item = deletionRef.current
    if (!item || item.busy || (!checkOnly && (!isConnected.current || item.uncertain))) return
    setDeletion({...item,busy:true,error:""})
    let plan = item.plan, attempted = false
    try {
      if (!plan) plan = unwrap(await api.redisEditPrepare({...scope,editId:item.session.editId}))
      attempted = !checkOnly
      const payload = {...scope,editId:item.session.editId,planId:plan.planId}
      const status = unwrap(await (checkOnly ? api.redisEditStatus(payload) : api.redisEditCommit(payload)))
      if (!alive.current) return
      if (status.status === "success") { release(item.session); discard(item.id); saved(item.id,item.session.key,true); setDeletion(null); toast.success("Key 已删除") }
      else setDeletion({...item,plan,busy:false,uncertain:status.status === "unknown" || status.status === "running",error:status.error?.message ?? "删除仍在进行，请检查状态。"})
    } catch (error) { if (alive.current) setDeletion({...item,plan,busy:false,uncertain:attempted || checkOnly,error:error instanceof Error ? error.message : "删除失败"}) }
  }
  function cancelDelete() { if (deletionRef.current?.busy) return; release(deletionRef.current?.session); setDeletion(null) }
  const busy = opening || Object.values(drafts).some(draft => draft.busy) || Boolean(deletion?.busy)
  function protect(action: () => void, ids = Object.keys(ref.current)) {
    if (openingRef.current || Object.values(ref.current).some(draft => draft.busy) || deletionRef.current?.busy) { toast.info("正在处理数据，请等待结果。"); return }
    const dirty = ids.filter(id => ref.current[id])
    if (dirty.length) setPending({action,ids:dirty}); else action()
  }
  async function recheck(id: string, patternId: string) {
    const draft = ref.current[id]
    if (!draft || !isConnected.current || draft.busy) return
    if (draft.creating) { release(draft.session); update(id,{session:null,plan:null,stale:false,uncertain:false,error:""}); return }
    update(id,{busy:true})
    try {
      const session = unwrap(await api.redisEditOpen({...scope,patternId,key:draft.key,mode:"update"}))
      if (!alive.current) { release(session); return }
      setReview({id,session})
    } catch (error) { update(id,{error:error instanceof Error ? error.message : "无法重新读取"}) }
    finally { if (alive.current) update(id,{busy:false}) }
  }
  function finishReview(accept: boolean) {
    const item = reviewRef.current
    if (!item) return
    if (accept) { release(ref.current[item.id]?.session); update(item.id,{session:item.session,plan:null,stale:false,uncertain:false,error:""}) }
    else release(item.session)
    setReview(null)
  }
  useEffect(() => { onDirtyChange(Object.keys(drafts).length > 0 || opening || Boolean(deletion)); }, [drafts, opening, deletion, onDirtyChange])
  useEffect(() => {
    for (const id of Object.keys(ref.current)) update(id,{stale:true,error:"连接已变化，草稿已保留。请重新读取并核对后继续。"})
    // 连接代次变化后保留本地输入，旧授权不再使用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, connectionEpoch])
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; Object.values(ref.current).forEach(draft => release(draft.session)); release(deletionRef.current?.session); release(reviewRef.current?.session); onDirtyChange(false) }
    // 所有草稿和授权只属于本次工作区会话。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return {drafts,update,discard,create,open,save,busy,deletion,confirmDelete,cancelDelete,protect,pending,cancelPending:()=>setPending(null),confirmPending:()=>{const item=pending;if(item){item.ids.forEach(discard);setPending(null);item.action()}},recheck,review,finishReview}
}
