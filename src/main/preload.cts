import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getStatus: () => ipcRenderer.invoke('agenthr:status'),
  selectPlatform: (platform: 'boss' | 'liepin') => ipcRenderer.invoke('agenthr:select-platform', platform),
  openPage: (page: 'login' | 'recommend' | 'messages') => ipcRenderer.invoke('agenthr:open-page', page),
  reloadPage: () => ipcRenderer.invoke('agenthr:reload-page'),
  setBrowserMode: (mode: 'collapsed' | 'split' | 'fullscreen') => ipcRenderer.invoke('agenthr:set-browser-mode', mode),
  setRightTab: (tab: 'files' | 'browser') => ipcRenderer.invoke('agenthr:set-right-tab', tab),
  setPaneLayout: (layout: { navWidth?: number; rightWidth?: number; navCollapsed?: boolean }) => ipcRenderer.invoke('agenthr:set-pane-layout', layout),
  pickFiles: () => ipcRenderer.invoke('agenthr:pick-files'),
  listWorkspaceFiles: () => ipcRenderer.invoke('agenthr:list-workspace-files'),
  listWorkspaceDirectory: (path = '') => ipcRenderer.invoke('agenthr:list-workspace-directory', path),
  readWorkspaceFile: (path: string) => ipcRenderer.invoke('agenthr:read-workspace-file', path),
  chooseWorkspace: () => ipcRenderer.invoke('agenthr:choose-workspace'),
  setBrowserControl: (control: 'agent' | 'human') => ipcRenderer.invoke('agenthr:set-browser-control', control),
  listVisibleCandidates: () => ipcRenderer.invoke('agenthr:list-visible-candidates'),
  captureVisibleCandidates: () => ipcRenderer.invoke('agenthr:capture-visible-candidates'),
  greetBossCandidate: (value: { assessmentId: string; fingerprint: string; confirmed: true }) => ipcRenderer.invoke('agenthr:greet-boss-candidate', value),
  listCandidates: (scope: 'active' | 'all') => ipcRenderer.invoke('agenthr:list-candidates', scope),
  setCandidateStage: (candidateId: string, stage: 'lead' | 'screening' | 'interview' | 'offer' | 'hired' | 'rejected', expectedUpdatedAt: string) => ipcRenderer.invoke('agenthr:set-candidate-stage', candidateId, stage, expectedUpdatedAt),
  updateCandidate: (id: string, expectedUpdatedAt: string, value: unknown) => ipcRenderer.invoke('agenthr:update-candidate', id, expectedUpdatedAt, value),
  mergeCandidates: (value: unknown) => ipcRenderer.invoke('agenthr:merge-candidates', value),
  readOpenResume: () => ipcRenderer.invoke('agenthr:read-open-resume'),
  saveOpenResume: (candidateId: string) => ipcRenderer.invoke('agenthr:save-open-resume', candidateId),
  getJobBrief: () => ipcRenderer.invoke('agenthr:get-job-brief'),
  listJobs: () => ipcRenderer.invoke('agenthr:list-jobs'),
  saveJobBrief: (brief: { role: string; requirements: string; criteria: string[] }, expectedUpdatedAt: string) => ipcRenderer.invoke('agenthr:save-job-brief', brief, expectedUpdatedAt),
  createJob: (brief: { role: string; requirements: string; criteria: string[] }) => ipcRenderer.invoke('agenthr:create-job', brief),
  activateJob: (id: string) => ipcRenderer.invoke('agenthr:activate-job', id),
  clearActiveJob: () => ipcRenderer.invoke('agenthr:clear-active-job'),
  listAssessments: (scope: 'active' | 'all') => ipcRenderer.invoke('agenthr:list-assessments', scope),
  setReviewStatus: (id: string, status: 'draft' | 'needs_clarification' | 'reviewed') => ipcRenderer.invoke('agenthr:set-review-status', id, status),
  listTasks: (scope: 'active' | 'all') => ipcRenderer.invoke('agenthr:list-tasks', scope),
  listSkills: () => ipcRenderer.invoke('agenthr:list-skills'),
  setSkillStatus: (id: string, status: 'enabled' | 'disabled', expectedUpdatedAt: string) => ipcRenderer.invoke('agenthr:set-skill-status', id, status, expectedUpdatedAt),
  runSkill: (id: string, parameters: Record<string, string | number | boolean>) => ipcRenderer.invoke('agenthr:run-skill', id, parameters),
  createTask: (value: unknown) => ipcRenderer.invoke('agenthr:create-task', value),
  getTask: (id: string) => ipcRenderer.invoke('agenthr:get-task', id),
  addTaskNote: (id: string, value: unknown) => ipcRenderer.invoke('agenthr:add-task-note', id, value),
  workOnTask: (id: string, mode: 'continue' | 'new_session') => ipcRenderer.invoke('agenthr:work-on-task', id, mode),
  setTaskStatus: (id: string, status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled', expectedUpdatedAt: string) => ipcRenderer.invoke('agenthr:set-task-status', id, status, expectedUpdatedAt),
  recordSkillStep: (id: string, value: unknown) => ipcRenderer.invoke('agenthr:record-skill-step', id, value),
  listRecruitmentEvents: () => ipcRenderer.invoke('agenthr:list-recruitment-events'),
  listPlatformValidations: () => ipcRenderer.invoke('agenthr:list-platform-validations'),
  validatePlatform: (check: 'candidate_list' | 'resume_detail') => ipcRenderer.invoke('agenthr:validate-platform', check),
  openDsh: () => ipcRenderer.invoke('agenthr:open-dsh'),
  restartDsh: () => ipcRenderer.invoke('agenthr:restart-dsh'),
  setWorkspaceTab: (tab: 'chat' | 'workspace') => ipcRenderer.invoke('agenthr:set-workspace-tab', tab),
  insertDshPrompt: (prompt: string) => ipcRenderer.invoke('agenthr:insert-dsh-prompt', prompt),
  newDshSession: () => ipcRenderer.invoke('agenthr:new-dsh-session'),
  onStatus: (listener: (status: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown) => listener(status)
    ipcRenderer.on('agenthr:status-changed', handler)
    return () => ipcRenderer.removeListener('agenthr:status-changed', handler)
  },
  onJobsChanged: (listener: () => void) => {
    const handler = () => listener()
    ipcRenderer.on('agenthr:jobs-changed', handler)
    return () => ipcRenderer.removeListener('agenthr:jobs-changed', handler)
  },
  onCandidatesChanged: (listener: () => void) => {
    const handler = () => listener()
    ipcRenderer.on('agenthr:candidates-changed', handler)
    return () => ipcRenderer.removeListener('agenthr:candidates-changed', handler)
  },
  onTasksChanged: (listener: () => void) => {
    const handler = () => listener()
    ipcRenderer.on('agenthr:tasks-changed', handler)
    return () => ipcRenderer.removeListener('agenthr:tasks-changed', handler)
  },
  onSkillsChanged: (listener: () => void) => {
    const handler = () => listener()
    ipcRenderer.on('agenthr:skills-changed', handler)
    return () => ipcRenderer.removeListener('agenthr:skills-changed', handler)
  },
  onRecordsChanged: (listener: () => void) => {
    const handler = () => listener()
    ipcRenderer.on('agenthr:records-changed', handler)
    return () => ipcRenderer.removeListener('agenthr:records-changed', handler)
  },
  onWorkspaceChanged: (listener: () => void) => {
    const handler = () => listener()
    ipcRenderer.on('agenthr:workspace-changed', handler)
    return () => ipcRenderer.removeListener('agenthr:workspace-changed', handler)
  },
}

contextBridge.exposeInMainWorld('agenthr', api)
