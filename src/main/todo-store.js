/**
 * 任务清单（todo_write）按窗口存储
 * todo_write 工具在主进程执行，结果需按 profileId 隔离，
 * 供覆盖层「任务清单」面板通过 IPC 读取。
 */
const store = new Map(); // profileId -> { list, updatedAt }

function setTodos(profileId, list) {
  const key = profileId || '__default__';
  store.set(key, {
    list: Array.isArray(list) ? list : [],
    updatedAt: Date.now(),
  });
}

function getTodos(profileId) {
  const key = profileId || '__default__';
  const e = store.get(key);
  if (!e) return { list: [], updatedAt: 0 };
  return { list: e.list, updatedAt: e.updatedAt };
}

module.exports = { setTodos, getTodos };
