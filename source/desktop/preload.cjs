const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('animeStudioDesktop', {
  platform: process.platform,
  transcode: (name, data, preset) => ipcRenderer.invoke('as:transcode', { name, data, preset }),
  gpuInfo: () => ipcRenderer.invoke('as:gpu'),
  videolab: (name, data, opts) => ipcRenderer.invoke('as:videolab', { name, data, opts }),
  cancelLab: () => ipcRenderer.invoke('as:videolab-cancel'),
  aiTools: () => ipcRenderer.invoke('as:ai-tools'),
  labPreview: (name, data, time, model, scale) => ipcRenderer.invoke('as:videolab-preview', { name, data, time, model, scale }),
  onLabProgress: cb => {
    const h = (_e, p) => cb(p)
    ipcRenderer.on('as:videolab-progress', h)
    return () => ipcRenderer.removeListener('as:videolab-progress', h)
  },
})
