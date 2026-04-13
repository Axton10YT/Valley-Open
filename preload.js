const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('valley', {
  getModels: () => ipcRenderer.invoke('get-models'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  downloadModel: (id) => ipcRenderer.invoke('download-model', id),
  startModel: (id) => ipcRenderer.invoke('start-model', id),
  stopModel: () => ipcRenderer.invoke('stop-model'),
  sendChat: (payload) => ipcRenderer.invoke('send-chat', payload),
  isAdmin: () => ipcRenderer.invoke('is-admin'),
  checkModelDownloaded: (id) => ipcRenderer.invoke('check-model-downloaded', id),
  deleteModel: (id) => ipcRenderer.invoke('delete-model', id),

  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (_, d) => cb(d)),
  onDownloadComplete: (cb) => ipcRenderer.on('download-complete', (_, d) => cb(d)),
  onDownloadError: (cb) => ipcRenderer.on('download-error', (_, d) => cb(d)),
  onChatToken: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('chat-token', handler);
    return () => ipcRenderer.removeListener('chat-token', handler);
  },
  onLlamaStopped: (cb) => ipcRenderer.on('llama-stopped', () => cb()),

  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),
});
