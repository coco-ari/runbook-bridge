import { softwareUpdateError } from './software-update-service.mjs';

const CHECKABLE_PHASES = new Set(['idle','current','error','no-source','source-required','available']);
const DEFAULT_CHECK_INTERVAL_MS = 15 * 60_000;

export function assertSoftwareUpdateIdle(v2) {
  try {
    if (!v2) throw softwareUpdateError('UPDATE_BUSY');
    const transfers = v2.serverWorkspaceFiles?.exitSummary?.() ?? {active:0,resumable:0};
    const sql = v2.v2Service?.mysqlSql?.exitSummary?.() ?? {active:0};
    const editing = v2.serverWorkspaceFiles?.editor?.exitSummary?.() ?? 0;
    const coordinator = v2.mutationCoordinator;
    const activity = [...(coordinator?.environmentActivity?.values() ?? [])];
    if (transfers.active || transfers.resumable || sql.active || editing || v2.unsavedWorkCount
      || v2.pluginEditSessionManager?.sessions?.size
      || activity.some(item => item.readers || item.writers)
      || coordinator?.environmentFences?.size || coordinator?.cloudProjects?.size || coordinator?.projectsDeleting?.size) {
      throw softwareUpdateError('UPDATE_BUSY');
    }
  } catch {
    // 无法确定工作区空闲时保留当前进程，不公开会话或配置细节。
    throw softwareUpdateError('UPDATE_BUSY');
  }
}

export function startSoftwareUpdateChecks(service,{intervalMs = DEFAULT_CHECK_INTERVAL_MS,onAvailable} = {}) {
  let disposed = false;
  let inFlight = null;
  const notifiedVersions = new Set();
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_CHECK_INTERVAL_MS;
  const checkNow = () => {
    if (disposed) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(async () => {
      if (disposed) return;
      let state = await service.invoke('status');
      if (disposed || state.supported !== true) return;
      if (CHECKABLE_PHASES.has(state.phase)) state = await service.invoke('check');
      if (disposed || state.phase !== 'available' || !state.availableVersion || !onAvailable || notifiedVersions.has(state.availableVersion)) return;
      notifiedVersions.add(state.availableVersion);
      await onAvailable(state);
    }).catch(() => {
      // 自动检查失败由更新服务保留状态，下次轮询可重试，不影响桌面使用。
    }).finally(() => { inFlight = null; });
    return inFlight;
  };
  const timer = setInterval(() => { void checkNow(); },interval);
  timer.unref?.();
  void checkNow();
  return {
    checkNow,
    dispose() { disposed = true; clearInterval(timer); },
  };
}
