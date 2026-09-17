// 原生窗口关闭和应用退出共用一次确认；确认前不终止任务或销毁窗口。
export function createTransferExitGuard({ summary, confirm, quit }) {
  let approved = false;
  let pending = false;
  return {
    allow(event) {
      if (approved) return true;
      const counts = summary();
      if (!pending && !counts.active && !counts.resumable) return true;
      event.preventDefault();
      if (!pending) {
        pending = true;
        Promise.resolve().then(() => confirm(counts)).then(accepted => {
          if (accepted !== true) return;
          approved = true;
          quit();
        }).catch(() => { approved = false; /* 对话框失败时保留窗口和传输任务。 */ }).finally(() => { pending = false; });
      }
      return false;
    },
  };
}
