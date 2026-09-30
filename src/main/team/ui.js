const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const pm = require('../profile-manager');
const ws = require('../window');
const tm = require('./task-manager');

/**
 * 显示 Worker 调度台（手动选择 Worker + 输入任务）
 * 派发统一走 dispatchTask（自动开新对话 + 初始化项目 + 发任务），与主大脑工具一致。
 */
function showDispatchUI() {
  return new Promise((resolve) => {
    let isResolved = false;
    const safeResolve = (val) => {
      if (!isResolved) { isResolved = true; resolve(val); }
    };

    const profiles = pm.readProfiles();
    const ctxs = ws.getAllContexts();
    const workers = ctxs.map(c => {
      const p = profiles.find(x => x.id === c.profileId);
      return {id:c.profileId, name:p?p.name:'', providerId:c.providerId};
    }).filter(x=>x.id);

    const uiWin = new BrowserWindow({
      width: 500, height: 600, title: 'Worker 调度台',
      parent: ws.getMainWindow() || undefined,
      modal: false,
      // 此处加载本地 HTML（调度台），非远程内容，故放宽隔离；勿改为加载远程 URL
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    const htmlPath = path.join(__dirname, 'dispatch-ui.html');
    uiWin.loadFile(htmlPath).catch(err => {
      safeResolve({success: false, error: 'UI 加载失败: ' + err.message});
      uiWin.close();
    });

    uiWin.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      safeResolve({success: false, error: 'UI 加载失败: ' + errorDescription});
      uiWin.close();
    });

    uiWin.webContents.on('did-finish-load', () => {
      uiWin.webContents.send('init-workers', workers);
    });

    const handler = async (event, { profileId, prompt, projectDir }) => {
      ipcMain.removeListener('ui-dispatch-task', handler);
      try {
        const ctx = ws.getWindowByProfileId(profileId);
        if (!ctx || !ctx.win) { safeResolve({success:false, error:'窗口未打开'}); uiWin.close(); return; }
        const { dispatchTask } = require('./dispatch');
        const res = await dispatchTask(profileId, prompt, projectDir, {});
        safeResolve(res && res.success ? { success: true, taskId: res.taskId } : { success: false, error: (res && res.error) || '派发失败' });
      } catch (err) {
        safeResolve({ success: false, error: err.message });
      }
      uiWin.close();
    };

    ipcMain.once('ui-dispatch-task', handler);

    uiWin.on('closed', () => {
      ipcMain.removeListener('ui-dispatch-task', handler);
      safeResolve({success:false, error:'user closed'});
    });

    setTimeout(() => {
      safeResolve({success: false, error: 'UI 窗口响应超时'});
      if (!uiWin.isDestroyed()) uiWin.close();
    }, 15000);
  });
}
module.exports = { showDispatchUI };
