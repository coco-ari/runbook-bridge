export function desktopMenuTemplate(platform = process.platform) {
  if (platform !== 'darwin') return null;
  return [
    { role:'appMenu' },
    { label:'文件', submenu:[{role:'close'}] },
    { role:'editMenu', label:'编辑' },
    { label:'视图', submenu:[{role:'resetZoom'}, {role:'zoomIn'}, {role:'zoomOut'}, {type:'separator'}, {role:'togglefullscreen'}] },
    { role:'windowMenu', label:'窗口' },
  ];
}
