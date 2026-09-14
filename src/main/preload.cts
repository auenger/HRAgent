import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getStatus: () => ipcRenderer.invoke('agenthr:status'),
  selectPlatform: (platform: 'boss' | 'liepin') => ipcRenderer.invoke('agenthr:select-platform', platform),
  openPage: (page: 'login' | 'recommend' | 'messages') => ipcRenderer.invoke('agenthr:open-page', page),
  reloadPage: () => ipcRenderer.invoke('agenthr:reload-page'),
  listVisibleCandidates: () => ipcRenderer.invoke('agenthr:list-visible-candidates'),
  readOpenResume: () => ipcRenderer.invoke('agenthr:read-open-resume'),
  getJobBrief: () => ipcRenderer.invoke('agenthr:get-job-brief'),
  listJobs: () => ipcRenderer.invoke('agenthr:list-jobs'),
  saveJobBrief: (brief: { role: string; requirements: string; criteria: string[] }) => ipcRenderer.invoke('agenthr:save-job-brief', brief),
  createJob: (brief: { role: string; requirements: string; criteria: string[] }) => ipcRenderer.invoke('agenthr:create-job', brief),
  activateJob: (id: string) => ipcRenderer.invoke('agenthr:activate-job', id),
  clearActiveJob: () => ipcRenderer.invoke('agenthr:clear-active-job'),
  listAssessments: (scope: 'active' | 'all') => ipcRenderer.invoke('agenthr:list-assessments', scope),
  setReviewStatus: (id: string, status: 'draft' | 'needs_clarification' | 'reviewed') => ipcRenderer.invoke('agenthr:set-review-status', id, status),
  openDsh: () => ipcRenderer.invoke('agenthr:open-dsh'),
  onStatus: (listener: (status: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown) => listener(status)
    ipcRenderer.on('agenthr:status-changed', handler)
    return () => ipcRenderer.removeListener('agenthr:status-changed', handler)
  },
}

contextBridge.exposeInMainWorld('agenthr', api)
