import { AppError } from './errors.mjs';

function environmentKey(projectId,environmentId) {
  return `${projectId}/${environmentId}`;
}

export class WorkspaceMutationCoordinator {
  constructor() {
    this.environmentQueues = new Map();
    this.environmentActivity = new Map();
    this.projectsDeleting = new Set();
  }

  assertProjectAvailable(projectId) {
    if (this.projectsDeleting.has(projectId)) {
      throw new AppError('PROJECT_DELETING', '项目正在删除，当前操作已取消。');
    }
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

  enqueueEnvironmentMutation(projectId,environmentId,operation) {
    try { this.assertProjectAvailable(projectId); }
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

  async runEnvironmentOperation(projectId,environmentId,operation) {
    this.assertProjectAvailable(projectId);
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

export const workspaceMutationInternals = {environmentKey};
