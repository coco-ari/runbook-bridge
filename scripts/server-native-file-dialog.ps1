param(
  [Parameter(Mandatory = $true)][int]$TargetProcessId,
  [Parameter(Mandatory = $true)][string]$DialogTitle,
  [Parameter(Mandatory = $true)][ValidateSet('select', 'cancel')][string]$PickerAction,
  [Parameter(Mandatory = $true)][string]$SelectedFile
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
# 原生控件缺少 UI Automation 操作模式时，仍只向已核对进程和父窗口的控件发送消息。
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RunbookNativePicker {
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int length);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW")] static extern IntPtr SendText(IntPtr window, uint message, IntPtr first, string text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")] static extern IntPtr SendButton(IntPtr window, uint message, IntPtr first, IntPtr second, uint flags, uint timeout, out UIntPtr result);
  static void Check(IntPtr parent, IntPtr child, uint expectedProcess, string expectedClass) {
    uint parentProcess, childProcess;
    GetWindowThreadProcessId(parent, out parentProcess);
    GetWindowThreadProcessId(child, out childProcess);
    var name = new StringBuilder(256);
    GetClassName(child, name, name.Capacity);
    if (parent == IntPtr.Zero || child == IntPtr.Zero || parentProcess != expectedProcess || childProcess != expectedProcess || !IsChild(parent, child) || !string.Equals(name.ToString(), expectedClass, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("拒绝不属于本次文件窗口的控件");
  }
  public static void SetText(IntPtr parent, IntPtr child, uint expectedProcess, string text) {
    Check(parent, child, expectedProcess, "Edit");
    UIntPtr result;
    if (SendText(child, 0x000C, IntPtr.Zero, text, 2, 2000, out result) == IntPtr.Zero) throw new InvalidOperationException("本次文件名输入超时");
  }
  public static void Click(IntPtr parent, IntPtr child, uint expectedProcess) {
    Check(parent, child, expectedProcess, "Button");
    UIntPtr result;
    if (SendButton(child, 0x00F5, IntPtr.Zero, IntPtr.Zero, 2, 2000, out result) == IntPtr.Zero) throw new InvalidOperationException("本次文件按钮操作超时");
  }
}
"@
$taskDirectory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($SelectedFile))
if ([IO.Path]::GetDirectoryName($taskDirectory).TrimEnd('\') -ne [IO.Path]::GetTempPath().TrimEnd('\') -or
    -not ([IO.Path]::GetFileName($taskDirectory) -match '^runbook-file-ui-[a-zA-Z0-9]+$') -or
    -not ([IO.Path]::GetFileName($SelectedFile) -match '^ui-[a-z-]+\.bin$')) { throw '实测只允许本次临时目录中的固定文件名' }
if (-not $DialogTitle.StartsWith('RunbookBridge 实测 ')) { throw '实测窗口标题无效' }

# 只定位当前 Electron 进程和随机实测标题；不向系统当前焦点发送按键。
$condition = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetProcessId)),
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $DialogTitle))
)
$picker = $null
$submitted = $false
$probeStage = 'find-window'
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  while ($null -eq $picker -and [DateTime]::UtcNow -lt $deadline) {
    $picker = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
    if ($null -eq $picker) {
      $ownerCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetProcessId)
      $owners = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $ownerCondition)
      foreach ($ownerWindow in $owners) {
        $picker = $ownerWindow.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
        if ($null -ne $picker) { break }
      }
    }
    if ($null -eq $picker) { Start-Sleep -Milliseconds 100 }
  }
  if ($null -eq $picker) { throw '未找到本次原生文件窗口' }
  if ($PickerAction -eq 'select') {
    $probeStage = 'set-file-name'
    $edit = $null
    foreach ($controlId in @('1001', '1148')) {
      $editCondition = New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Edit')),
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $controlId))
      )
      $edit = $picker.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCondition)
      if ($null -ne $edit) { break }
    }
    if ($null -eq $edit) { throw '没有文件名输入控件' }
    [RunbookNativePicker]::SetText([IntPtr]$picker.Current.NativeWindowHandle, [IntPtr]$edit.Current.NativeWindowHandle, $TargetProcessId, $SelectedFile)
  }
  $probeStage = 'invoke-button'
  $buttonId = if ($PickerAction -eq 'cancel') { '2' } else { '1' }
  $buttonCondition = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.OrCondition(
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Pane))
    )),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $buttonId))
  )
  $button = $picker.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
  if ($null -eq $button) { throw '没有本次文件窗口操作按钮' }
  if ($PickerAction -eq 'cancel' -and $button.Current.Name -notmatch '^(取消|Cancel)') { throw '拒绝非取消按钮' }
  if ($PickerAction -eq 'select' -and $button.Current.Name -notmatch '^(打开|保存|Open|Save)') { throw '拒绝非文件确认按钮' }
  [RunbookNativePicker]::Click([IntPtr]$picker.Current.NativeWindowHandle, [IntPtr]$button.Current.NativeWindowHandle, $TargetProcessId)
  $submitted = $true
  Write-Output '{"nativePickerDriven":true}'
} catch {
  [Console]::Out.WriteLine(('{"nativePickerFailureStage":"' + $probeStage + '","exceptionType":"' + $_.Exception.GetType().Name + '"}'))
  [Console]::Error.WriteLine('本次原生文件窗口操作失败')
  exit 1
} finally {
  if ($null -ne $picker -and -not $submitted) {
    try { $picker.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close() } catch {}
  }
}
