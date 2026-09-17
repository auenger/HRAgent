interface AgentHrStatus {
  browser?: { platform: 'boss' | 'liepin'; url: string; title: string; loading: boolean; active?: true; error?: string; lastAction?: { action: string; target: string; result: 'running' | 'succeeded' | 'failed'; at: string } }
  dsh?: { phase: 'unconfigured' | 'starting' | 'ready' | 'stopped' | 'failed'; url?: string; detail?: string }
  workspace?: { path: string; name: string }
  shell?: {
    browserMode: 'collapsed' | 'split' | 'fullscreen'
    rightTab: 'files' | 'browser'
    browserControl: 'agent' | 'human'
    workspaceTab: 'chat' | 'workspace'
    navWidth: number
    navCollapsed: boolean
    rightWidth: number
  }
}

interface WorkspaceFile {
  path: string
  name: string
  size: number
  updatedAt: string
  previewable: boolean
  content: string
}

interface CandidatePreview {
  cardIndex: number
  name: string
  skills: string
  summary: string
  fingerprint?: string
}

interface CandidateRecord {
  id: string
  displayName: string
  currentCompany: string
  currentTitle: string
  location: string
  expectedSalary: string
  expectedPosition: string
  stage: 'lead' | 'screening' | 'interview' | 'offer' | 'hired' | 'rejected'
  tags: string[]
  notes: string
  sourcePlatforms: Array<'boss' | 'liepin'>
  sourceCount: number
  jobIds: string[]
  createdAt: string
  updatedAt: string
}

interface RecruitmentTask {
  id: string
  jobId: string | null
  type: 'search' | 'analyze' | 'confirm' | 'follow_up'
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  platform: 'boss' | 'liepin' | null
  profileId: string | null
  progress: number
  currentCandidateId: string | null
  title: string
  description: string
  resultSummary: string
  lastBrowserUrl: string | null
  runCount: number
  errorCode: string | null
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  updatedAt: string
}
interface TaskEntry { id: string; taskId: string; kind: 'analysis' | 'browser_result' | 'note'; title: string; content: string; sourceUrl: string | null; createdAt: string }
interface TaskFile { path: string; kind: 'input' | 'output'; createdAt: string }
interface RecruitmentTaskDetail { task: RecruitmentTask; entries: TaskEntry[]; files: TaskFile[] }

interface RecruitmentEvent {
  id: string
  type: string
  entityType: 'job' | 'candidate' | 'application' | 'task' | 'assessment'
  entityId: string
  summary: string
  createdAt: string
}
interface PlatformValidationRecord {
  id: string
  platform: 'boss' | 'liepin'
  check: 'candidate_list' | 'resume_detail'
  status: 'passed' | 'failed'
  summary: string
  runId: string
  createdAt: string
}

interface OpenResume { name: string; text: string }
interface JobBrief {
  role: string
  requirements: string
  criteria: string[]
  salaryRange: string
  location: string
  employmentType: 'full_time' | 'part_time' | 'contract' | 'internship'
  status: 'draft' | 'open' | 'paused' | 'closed'
  hiringTarget: number
}
interface JobRecord extends JobBrief { id: string; createdAt: string; updatedAt: string }
interface JobList { activeId: string | null; jobs: JobRecord[] }
interface AssessmentCard {
  id: string
  createdAt: string
  platform: 'liepin' | 'boss'
  candidateName: string
  role: string
  requirements: string
  sourceDigest: string
  jobBriefDigest: string
  findings: Array<{
    criterion: string
    verdict: 'explicit_evidence' | 'related_clue' | 'unknown' | 'explicit_mismatch'
    evidenceQuote: string
    reasoning: string
    questionDraft: string
  }>
  reviewStatus: 'draft' | 'needs_clarification' | 'reviewed'
  reviewUpdatedAt: string | null
  greeting?: {
    id: string
    result: 'greeted' | 'already_contacted'
    createdAt: string
  } | null
}

interface Window {
  agenthr: {
    getStatus(): Promise<AgentHrStatus>
    selectPlatform(platform: 'boss' | 'liepin'): Promise<void>
    openPage(page: 'login' | 'recommend' | 'messages'): Promise<void>
    reloadPage(): Promise<void>
    setBrowserMode(mode: 'collapsed' | 'split' | 'fullscreen'): Promise<void>
    setRightTab(tab: 'files' | 'browser'): Promise<void>
    setPaneLayout(layout: { navWidth?: number; rightWidth?: number; navCollapsed?: boolean }): Promise<void>
    pickFiles(): Promise<WorkspaceFile[]>
    listWorkspaceFiles(): Promise<WorkspaceFile[]>
    chooseWorkspace(): Promise<{ path: string; name: string }>
    setBrowserControl(control: 'agent' | 'human'): Promise<void>
    listVisibleCandidates(): Promise<CandidatePreview[]>
    captureVisibleCandidates(): Promise<CandidateRecord[]>
    greetBossCandidate(value: { assessmentId: string; fingerprint: string; confirmed: true }): Promise<{ result: 'greeted' | 'already_contacted' }>
    listCandidates(scope: 'active' | 'all'): Promise<CandidateRecord[]>
    setCandidateStage(candidateId: string, stage: CandidateRecord['stage'], expectedUpdatedAt: string): Promise<CandidateRecord>
    updateCandidate(id: string, expectedUpdatedAt: string, value: Partial<Pick<CandidateRecord, 'displayName' | 'currentCompany' | 'currentTitle' | 'location' | 'expectedSalary' | 'expectedPosition' | 'tags' | 'notes'>>): Promise<CandidateRecord>
    mergeCandidates(value: { primaryId: string; duplicateId: string; expectedPrimaryUpdatedAt: string; expectedDuplicateUpdatedAt: string; confirmed: true }): Promise<CandidateRecord>
    readOpenResume(): Promise<OpenResume>
    saveOpenResume(candidateId: string): Promise<WorkspaceFile>
    getJobBrief(): Promise<JobBrief | null>
    listJobs(): Promise<JobList>
    saveJobBrief(brief: JobBrief, expectedUpdatedAt: string): Promise<JobRecord>
    createJob(brief: JobBrief): Promise<JobRecord>
    activateJob(id: string): Promise<JobRecord>
    clearActiveJob(): Promise<void>
    listAssessments(scope: 'active' | 'all'): Promise<AssessmentCard[]>
    setReviewStatus(id: string, status: AssessmentCard['reviewStatus']): Promise<AssessmentCard>
    listTasks(scope: 'active' | 'all'): Promise<RecruitmentTask[]>
    createTask(value: { jobId?: string | null; type: RecruitmentTask['type']; platform?: 'boss' | 'liepin' | null; profileId?: string | null; title: string; description: string; workspacePaths?: string[] }): Promise<RecruitmentTask>
    getTask(id: string): Promise<RecruitmentTaskDetail>
    addTaskNote(id: string, value: { title: string; content: string }): Promise<RecruitmentTaskDetail>
    workOnTask(id: string, mode: 'continue' | 'new_session'): Promise<RecruitmentTask>
    setTaskStatus(id: string, status: RecruitmentTask['status'], expectedUpdatedAt: string): Promise<RecruitmentTask>
    listRecruitmentEvents(): Promise<RecruitmentEvent[]>
    listPlatformValidations(): Promise<PlatformValidationRecord[]>
    validatePlatform(check: PlatformValidationRecord['check']): Promise<PlatformValidationRecord>
    openDsh(): Promise<void>
    restartDsh(): Promise<void>
    setWorkspaceTab(tab: 'chat' | 'workspace'): Promise<void>
    insertDshPrompt(prompt: string): Promise<void>
    newDshSession(): Promise<void>
    onStatus(listener: (status: AgentHrStatus) => void): () => void
    onJobsChanged(listener: () => void): () => void
    onCandidatesChanged(listener: () => void): () => void
    onTasksChanged(listener: () => void): () => void
    onRecordsChanged(listener: () => void): () => void
    onWorkspaceChanged(listener: () => void): () => void
  }
}
