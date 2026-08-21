import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // 后续扩展：执行引擎通信、文件操作等
});
