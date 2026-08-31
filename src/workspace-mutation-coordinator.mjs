import { AppError } from './errors.mjs';

function environmentKey(projectId,environmentId) {
  return `${projectId}/${environmentId}`;
}

export class WorkspaceMutationCoordinator {
  constructor() {
    this.environmentQueues = new Map();
    this.environmentActivity = new Map();
    this.environmentFences = new Map();
    this.projectsDeleting = new Set();
  }

  assertProjectAvailable(projectId) {
    if (this.projectsDeleting.has(projectId)) {
      throw new AppError('PROJECT_DELETING', '项目正在删除，当前操作已取消。');
    }
  }

  assertEnvironmentAvailable(projectId,environmentId,{ownerId = null} = {}) {
    this.assertProjectAvailable(projectId);
    const fence = this.environmentFences.get(environmentKey(projectId,environmentId));
    if (fence && fence.ownerId !== ownerId) {
      throw new AppError('PLUGIN_EDIT_BUSY','插件连接配置正在编辑，请等待编辑结束后再操作。',{
        editSessionId:fence.kind === 'edit' ? fence.ownerId : null,
        affectedPluginInstanceIds:[...fence.affectedPluginInstanceIds],
      });
    }
  }

  installEnvironmentEditFence(projectId,environmentId,editSessionId,affectedPluginInstanceIds = []) {
    this.assertProjectAvailable(projectId);
    const key = environmentKey(projectId,environmentId);
    if (this.environmentFences.has(key)) throw new AppError('PLUGIN_EDIT_BUSY','当前环境已有连接配置编辑会话。');
    const fence = {
      kind:'edit',
      ownerId:String(editSessionId),
      projectId,
      environmentId,
      affectedPluginInstanceIds:[...new Set(affectedPluginInstanceIds)],
      installedAt:new Date().toISOString(),
    };
    this.environmentFences.set(key,fence);
    return structuredClone(fence);
  }

  handoffEnvironmentEditFence(editSessionId,planId) {
    for (const [key,fence] of this.environmentFences) {
      if (fence.kind !== 'edit' || fence.ownerId !== String(editSessionId)) continue;
      const handed = {...fence,kind:'connection-plan',ownerId:String(planId),editSessionId:String(editSessionId)};
      this.environmentFences.set(key,handed);
      return structuredClone(handed);
    }
    throw new AppError('PLUGIN_EDIT_SESSION_STALE','编辑会话已经结束或不再拥有连接门禁。');
  }

  releaseEnvironmentFence(ownerId) {
    for (const [key,fence] of this.environmentFences) {
      if (fence.ownerId === String(ownerId)) {
        this.environmentFences.delete(key);
        return true;
      }
    }
    return false;
  }

  environmentFence(projectId,environmentId) {
    const fence = this.environmentFences.get(environmentKey(projectId,environmentId));
    return fence ? structuredClone(fence) : null;
  }

  environmentActivitySnapshot(projectId,environmentId) {
    const key = environmentKey(projectId,environmentId);
    const state = this.environmentActivity.get(key);
    return {
      readers:state?.readers ?? 0,
      writers:state?.writers ?? 0,
      fenced:Boolean(this.environmentFences.get(key)),
    };
  }

  activity(key) {
    let state = this.environmentActivity.get(key);
    if (!state) {
      state = {readers:0,writers:0,drainPromise:null,resolveDrain:null};
      this.environmentActivity.set(key,state);
    }
    return state;
  }

  cleanupActivity(key,state) {
    if (state.readers === 0 && state.writers === 0 && this.environmentActivity.get(key) === state) {
      this.environmentActivity.delete(key);
    }
  }

  async waitReaders(state) {
    if (state.readers === 0) return;
    if (!state.drainPromise) {
      state.drainPromise = new Promise((resolve) => { state.resolveDrain = resolve; });
    }
    await state.drainPromise;
  }

  enqueueEnvironmentMutation(projectId,environmentId,operation,{ownerId = null} = {}) {
    try { this.assertEnvironmentAvailable(projectId,environmentId,{ownerId}); }
    catch (error) { return Promise.reject(error); }
    const key = environmentKey(projectId,environmentId);
    const state = this.activity(key);
    state.writers += 1;
    const previous = this.environmentQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      await this.waitReaders(state);
      return operation();
    });
    this.environmentQueues.set(key,current);
    return current.finally(() => {
      state.writers = Math.max(0,state.writers - 1);
      if (this.environmentQueues.get(key) === current) this.environmentQueues.delete(key);
      this.cleanupActivity(key,state);
    });
  }

  async runEnvironmentOperation(projectId,environmentId,operation,{ownerId = null} = {}) {
    this.assertEnvironmentAvailable(projectId,environmentId,{ownerId});
    const key = environmentKey(projectId,environmentId);
    const state = this.activity(key);
    if (state.writers > 0) {
      this.cleanupActivity(key,state);
      throw new AppError('CONFIGURATION_UPDATING', '环境配置正在保存，请稍后重试操作。');
    }
    state.readers += 1;
    try { return await operation(); }
    finally {
      state.readers = Math.max(0,state.readers - 1);
      if (state.readers === 0 && state.resolveDrain) {
        const resolve = state.resolveDrain;
        state.resolveDrain = null;
        state.drainPromise = null;
        resolve();
      }
      this.cleanupActivity(key,state);
    }
  }

  async waitEnvironmentDrain(projectId,environmentId,{timeoutMs = 10_000,signal = null} = {}) {
    const key = environmentKey(projectId,environmentId);
    const startedAt = Date.now();
    while (true) {
      if (signal?.aborted) throw new AppError('PLUGIN_EDIT_DRAIN_CANCELLED','已取消等待正在进行的操作。');
      const state = this.environmentActivity.get(key);
      const pendingWriter = this.environmentQueues.get(key);
      const readers = state?.readers ?? 0;
      const writers = state?.writers ?? 0;
      if (!readers && !writers && !pendingWriter) return {drained:true,waitedMs:Date.now() - startedAt};
      const remaining = Math.max(0,Number(timeoutMs) - (Date.now() - startedAt));
      if (!remaining) {
        throw new AppError('PLUGIN_EDIT_DRAIN_TIMEOUT','等待正在进行的 Agent 或配置操作超时。',{
          activeOperations:{readers,writers},
        });
      }
      const pending = [
        ...(readers && state ? [this.waitReaders(state)] : []),
        ...(pendingWriter ? [Promise.resolve(pendingWriter).catch(() => undefined)] : []),
      ];
      let timer;
      let onAbort;
      try {
        await Promise.race([
          Promise.all(pending),
          new Promise((_,reject) => {
            timer = setTimeout(() => reject(new AppError('PLUGIN_EDIT_DRAIN_TIMEOUT','等待正在进行的 Agent 或配置操作超时。',{
              activeOperations:{readers,writers},
            })),remaining);
            timer.unref?.();
          }),
          ...(signal ? [new Promise((_,reject) => {
            onAbort = () => reject(new AppError('PLUGIN_EDIT_DRAIN_CANCELLED','已取消等待正在进行的操作。'));
            signal.addEventListener('abort',onAbort,{once:true});
          })] : []),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) signal.removeEventListener('abort',onAbort);
      }
    }
  }

  beginProjectDelete(projectId) {
    if (this.projectsDeleting.has(projectId)) throw new AppError('PROJECT_DELETING', '项目正在删除。');
    this.projectsDeleting.add(projectId);
  }

  endProjectDelete(projectId) {
    this.projectsDeleting.delete(projectId);
  }

  async waitProjectActivity(projectId) {
    const prefix = `${projectId}/`;
    while (true) {
      const pending = [...this.environmentQueues.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([,promise]) => promise);
      const readers = [...this.environmentActivity.entries()]
        .filter(([key,state]) => key.startsWith(prefix) && state.readers > 0)
        .map(([,state]) => this.waitReaders(state));
      if (!pending.length && !readers.length) return;
      await Promise.allSettled([...pending,...readers]);
    }
  }
}
