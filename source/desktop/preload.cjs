const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('animeStudioDesktop', {
  platform: process.platform,
  transcode: (name, data, preset) => ipcRenderer.invoke('as:transcode', { name, data, preset }),
  gpuInfo: () => ipcRenderer.invoke('as:gpu'),
})
