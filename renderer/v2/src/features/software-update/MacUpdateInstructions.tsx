export function MacUpdateInstructions() {
  return <div className="space-y-2 border-t pt-3 text-xs leading-5 text-muted-foreground" data-testid="software-update-mac-instructions">
    <p className="font-medium text-foreground">覆盖安装步骤</p>
    <ol className="list-decimal space-y-1 pl-5">
      <li>保存工作内容，结束 SQL 事务和文件传输，再通过应用菜单退出工作台；关闭正在使用工作台的 Agent 客户端。</li>
      <li>将 DMG 中的“Agent运维工作台”拖到原安装位置并选择“替换”，通常是“应用程序”目录。如果正从 DMG 运行，请先复制到“应用程序”。</li>
      <li>从原安装位置启动新版本，再重新打开 Agent 客户端。覆盖应用会保留原有配置数据，请勿删除数据目录。</li>
    </ol>
    <p>此分发通道可能提供未经过 Apple 公证的应用。若系统提示无法验证开发者，请先确认来源，再按“系统设置 → 隐私与安全性”的提示处理；损坏或恶意软件提示应联系发布管理员检查。</p>
    <p>打开安装包后仍需手动覆盖。若退出后尚未安装，可继续使用已打开的 DMG；重新启动旧版后需重新检查和下载。</p>
  </div>
}
