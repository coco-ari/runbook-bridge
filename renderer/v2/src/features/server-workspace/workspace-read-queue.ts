type PendingRead = {
  owner: object
  key: string
  background: boolean
  kind: "directory" | "file"
  resource: string
  current: () => boolean
  start: () => void
  skip: () => void
}

// 同一桌面 API 共用四个读取名额；目录最多三个，每个插件的预览和属性最多两个。
export function createWorkspaceReadQueue() {
  let active = 0
  let directories = 0
  const files = new Map<string, number>()
  const pending: PendingRead[] = []
  const drain = () => {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (!pending[index]!.current()) pending.splice(index, 1)[0]!.skip()
    }
    while (active < 4 && pending.length) {
      const eligible = (item: PendingRead) => item.kind === "file" ? (files.get(item.resource) ?? 0) < 2 : directories < 3
      // 已打开的预览和属性优先于等待中的目录扫描，避免当前查看任务排在旧展开之后。
      const file = pending.findIndex(item => item.kind === "file" && eligible(item) && !item.background)
      const interactive = file < 0 ? pending.findIndex(item => eligible(item) && !item.background) : file
      const index = interactive < 0 ? pending.findIndex(eligible) : interactive
      if (index < 0) break
      const item = pending.splice(index, 1)[0]!
      active += 1
      if (item.kind === "directory") directories += 1
      else files.set(item.resource, (files.get(item.resource) ?? 0) + 1)
      item.start()
    }
  }
  return {
    run<T>(owner: object, key: string, operation: () => Promise<T>, current: () => boolean, { background = false, kind = "directory", resource = "" }: { background?: boolean; kind?: "directory" | "file"; resource?: string } = {}): Promise<T | undefined> {
      return new Promise((resolve, reject) => {
        pending.push({ owner, key, background, kind, resource, current, skip: () => resolve(undefined), start: () => {
          Promise.resolve().then(operation).then(resolve, reject).finally(() => {
            active -= 1
            if (kind === "directory") directories -= 1
            else {
              const remaining = (files.get(resource) ?? 1) - 1
              if (remaining) files.set(resource, remaining)
              else files.delete(resource)
            }
            drain()
          })
        } })
        drain()
      })
    },
    cancel(owner: object, key?: string | ((value: string) => boolean)) {
      // 只撤销尚未发出的读取，在途请求保持原有安全校验和错误处理。
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const item = pending[index]!
        if (item.owner === owner && (key === undefined || (typeof key === "function" ? key(item.key) : item.key === key))) pending.splice(index, 1)[0]!.skip()
      }
    },
  }
}

const queues = new WeakMap<object, ReturnType<typeof createWorkspaceReadQueue>>()
export function workspaceReadQueue(api: object) {
  let queue = queues.get(api)
  if (!queue) { queue = createWorkspaceReadQueue(); queues.set(api, queue) }
  return queue
}
