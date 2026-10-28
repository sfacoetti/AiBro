const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (cb) => {
  const h = (_e, data) => cb(data);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('aibro', {
  state: invoke('state'),
  config: invoke('config'),
  setConfig: invoke('config:set'),
  resolveApproval: invoke('approval:resolve'),
  sessionMessages: invoke('session:messages'),
  send: invoke('session:send'),
  interrupt: invoke('session:interrupt'),
  closeSession: invoke('session:close'),
  startSession: invoke('session:start'),
  resumeSession: invoke('session:resume'),
  recentSessions: invoke('sessions:recent'),
  pickFolder: invoke('pick-folder'),
  focusApp: invoke('apps:focus'),
  refreshApps: invoke('apps:refresh'),
  refreshUsage: invoke('usage:refresh'),
  setGithubToken: invoke('github:set-token'),
  refreshGithub: invoke('github:refresh'),
  markGithubRead: invoke('github:mark-read'),
  rerunAction: invoke('github:rerun'),
  openUrl: invoke('open-url'),
  gitPush: invoke('git:push'),
  gitPull: invoke('git:pull'),
  gitOpenFolder: invoke('git:open-folder'),
  installHooks: invoke('hooks:install'),
  uninstallHooks: invoke('hooks:uninstall'),
  hide: invoke('window:hide'),
  openMain: invoke('buddy:open'),
  toggleMain: invoke('buddy:toggle'),
  buddyMood: invoke('buddy:mood'),
  buddyDrag: invoke('buddy:drag'),
  buddyIgnoreMouse: invoke('buddy:ignore-mouse'),
  onBuddyMood: on('buddy-mood'),
  onBuddyMotion: on('buddy-motion'),
  onBuddyGlow: on('buddy-glow'),
  onState: on('state'),
  onMessages: on('session-messages'),
  onFocusApproval: on('focus-approval'),
  onOpenSession: on('open-session'),
});
