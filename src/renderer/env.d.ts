interface AgentHrStatus {
  browser?: { platform: 'boss' | 'liepin'; url: string; title: string; loading: boolean; error?: string }
  dsh?: { phase: 'unconfigured' | 'starting' | 'ready' | 'stopped' | 'failed'; url?: string; detail?: string }
}

interface CandidatePreview {
  cardIndex: number
  name: string
  skills: string
  summary: string
}

interface OpenResume { name: string; text: string }
interface JobBrief { role: string; requirements: string; criteria: string[] }
interface JobRecord extends JobBrief { id: string; updatedAt: string }
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
}

interface Window {
  agenthr: {
    getStatus(): Promise<AgentHrStatus>
    selectPlatform(platform: 'boss' | 'liepin'): Promise<void>
    openPage(page: 'login' | 'recommend' | 'messages'): Promise<void>
    reloadPage(): Promise<void>
    listVisibleCandidates(): Promise<CandidatePreview[]>
    readOpenResume(): Promise<OpenResume>
    getJobBrief(): Promise<JobBrief | null>
    listJobs(): Promise<JobList>
    saveJobBrief(brief: JobBrief): Promise<JobRecord>
    createJob(brief: JobBrief): Promise<JobRecord>
    activateJob(id: string): Promise<JobRecord>
    clearActiveJob(): Promise<void>
    listAssessments(scope: 'active' | 'all'): Promise<AssessmentCard[]>
    setReviewStatus(id: string, status: AssessmentCard['reviewStatus']): Promise<AssessmentCard>
    openDsh(): Promise<void>
    onStatus(listener: (status: AgentHrStatus) => void): () => void
  }
}
