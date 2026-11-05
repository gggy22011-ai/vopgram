const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('VOP_DESKTOP', true);
