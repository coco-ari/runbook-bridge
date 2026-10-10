import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"

export function SoftwareUpdateConfirmation({ open, onOpenChange, version, disabled, onInstall }: {
  readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly version?: string | null; readonly disabled: boolean; readonly onInstall: () => void
}) {
  return <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogContent data-testid="software-update-confirm"><AlertDialogHeader><AlertDialogTitle>立即更新到 {version}？</AlertDialogTitle><AlertDialogDescription>更新将重启应用并关闭当前工作区和连接，保留本机项目配置与已保存凭据。请先保存工作内容并结束 SQL 事务和文件传输；仍有活动任务时会阻止安装。更新后重新打开 Agent 客户端以恢复接入。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel data-testid="software-update-install-cancel">取消</AlertDialogCancel><AlertDialogAction data-testid="software-update-install-confirm" disabled={disabled} onClick={onInstall}>确认重启更新</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
  </AlertDialog>
}
