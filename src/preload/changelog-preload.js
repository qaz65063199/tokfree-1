/**
 * 更新日志弹窗 Preload
 * 仅暴露只读接口：读取解析后的 CHANGELOG。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('changelogAPI', {
  getChangelog: () => ipcRenderer.invoke('get-changelog'),
});
