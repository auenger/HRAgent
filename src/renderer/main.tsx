import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowsInSimple, ArrowsLeftRight, ArrowsOutSimple, Briefcase, Browsers, ChatCircleDots, CheckCircle, ClockCounterClockwise, FileText, FolderOpen, GearSix, ListChecks, MagnifyingGlass, Pause, Play, Plus, SidebarSimple, SignIn, Sparkle, SquaresFour, UserList, UsersThree, WarningCircle, X } from '@phosphor-icons/react'
import './style.css'

type Platform = 'boss' | 'liepin'
type BrowserMode = 'collapsed' | 'split' | 'fullscreen'
type NavId = 'chat' | 'jobs' | 'talent' | 'tasks' | 'records' | 'accounts' | 'settings'
const navItems = [
  { id: 'chat' as const, label: 'AI 工作台', icon: ChatCircleDots }, { id: 'jobs' as const, label: '岗位管理', icon: Briefcase },
  { id: 'talent' as const, label: '人才库', icon: UsersThree }, { id: 'tasks' as const, label: '招聘任务', icon: ListChecks },
  { id: 'records' as const, label: '招聘记录', icon: ClockCounterClockwise }, { id: 'accounts' as const, label: '平台账号', icon: Browsers },
  { id: 'settings' as const, label: '设置', icon: GearSix },
]
const pageTitles: Record<NavId, { title: string; subtitle: string }> = {
  chat: { title: 'AI 工作台', subtitle: '描述目标，Agent 会调用岗位、人才与浏览器工具完成工作。' },
  jobs: { title: '岗位管理', subtitle: '维护岗位条件，所有候选人判断都以已保存版本为准。' },
  talent: { title: '人才库', subtitle: '查看当前线索、简历快照和跨平台分析结果。' },
  tasks: { title: '招聘任务', subtitle: '跟踪搜索、读取、分析和人工确认的执行状态。' },
  records: { title: '招聘记录', subtitle: '复核带来源和原文证据的候选人判断。' },
  accounts: { title: '平台账号', subtitle: '管理招聘平台会话、页面状态与人工接管。' },
  settings: { title: '设置', subtitle: '查看本机运行时、安全边界和数据策略。' },
}
const emptyJob: JobBrief = { role: '', requirements: '', criteria: [], salaryRange: '', location: '', employmentType: 'full_time', status: 'draft', hiringTarget: 1 }
function toJobBrief(job: JobRecord): JobBrief {
  return { role: job.role, requirements: job.requirements, criteria: job.criteria, salaryRange: job.salaryRange, location: job.location, employmentType: job.employmentType, status: job.status, hiringTarget: job.hiringTarget }
}

// Native tooltips remain visible above Electron's sibling WebContentsViews.
// Require an accessible name so new icon-only buttons cannot omit their tooltip.
function IconButton({ title, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { 'aria-label': string }) {
  const tooltip = title || props['aria-label']
  return <button type="button" {...props} title={tooltip} data-tooltip={tooltip}
    className={['icon-tooltip', props.className].filter(Boolean).join(' ')} />
}

function App() {
  const [status, setStatus] = useState<AgentHrStatus>({})
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [activeNav, setActiveNav] = useState<NavId>('chat')
  const [talentPool, setTalentPool] = useState<CandidateRecord[]>([])
  const [tasks, setTasks] = useState<RecruitmentTask[]>([])
  const [events, setEvents] = useState<RecruitmentEvent[]>([])
  const [resume, setResume] = useState<OpenResume | null>(null)
  const [jobBrief, setJobBrief] = useState<JobBrief>(emptyJob)
  const [criteriaInput, setCriteriaInput] = useState(''), [jobBriefSaved, setJobBriefSaved] = useState(false)
  const [jobList, setJobList] = useState<JobList>({ activeId: null, jobs: [] }), [newJob, setNewJob] = useState(true)
  const [assessments, setAssessments] = useState<AssessmentCard[]>([])
  const [assessmentScope, setAssessmentScope] = useState<'active' | 'all'>('active')
  const [workFiles, setWorkFiles] = useState<WorkspaceFile[]>([])
  const [selectedFile, setSelectedFile] = useState('')
  const [layoutDraft, setLayoutDraft] = useState<{ navWidth?: number; rightWidth?: number }>({})

  function applyJobList(value: JobList) {
    setJobList(value)
    const active = value.jobs.find(job => job.id === value.activeId)
    if (!active) return
    setJobBrief(toJobBrief(active))
    setCriteriaInput(active.criteria.join('\n')); setJobBriefSaved(true); setNewJob(false)
  }
  useEffect(() => {
    void window.agenthr.getStatus().then(setStatus).catch(e => setError(String(e)))
    void window.agenthr.listJobs().then(applyJobList).catch(e => setError(String(e)))
    void window.agenthr.listAssessments('active').then(setAssessments).catch(e => setError(String(e)))
    void window.agenthr.listCandidates('active').then(setTalentPool).catch(e => setError(String(e)))
    void window.agenthr.listTasks('all').then(setTasks).catch(e => setError(String(e)))
    void window.agenthr.listRecruitmentEvents().then(setEvents).catch(e => setError(String(e)))
    void window.agenthr.listWorkspaceFiles().then(setWorkFiles).catch(e => setError(String(e)))
    const stopStatus = window.agenthr.onStatus(setStatus)
    const stopJobs = window.agenthr.onJobsChanged(() => void window.agenthr.listJobs().then(applyJobList).catch(e => setError(String(e))))
    const stopCandidates = window.agenthr.onCandidatesChanged(() => void window.agenthr.listCandidates('active').then(setTalentPool).catch(e => setError(String(e))))
    const stopTasks = window.agenthr.onTasksChanged(() => void window.agenthr.listTasks('all').then(setTasks).catch(e => setError(String(e))))
    const stopRecords = window.agenthr.onRecordsChanged(() => { void window.agenthr.listAssessments('active').then(setAssessments); void window.agenthr.listRecruitmentEvents().then(setEvents) })
    const stopWorkspace = window.agenthr.onWorkspaceChanged(() => { void window.agenthr.getStatus().then(setStatus); void window.agenthr.listWorkspaceFiles().then(setWorkFiles).catch(e => setError(String(e))) })
    return () => { stopStatus(); stopJobs(); stopCandidates(); stopTasks(); stopRecords(); stopWorkspace() }
  }, [])
  useEffect(() => { setResume(null) }, [status.browser?.platform, status.browser?.url, status.browser?.loading])
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }
  async function navigate(id: NavId) {
    setActiveNav(id); await window.agenthr.setWorkspaceTab(id === 'chat' ? 'chat' : 'workspace')
    if (id !== 'chat') {
      applyJobList(await window.agenthr.listJobs()); setAssessments(await window.agenthr.listAssessments(assessmentScope))
      setTalentPool(await window.agenthr.listCandidates('active')); setTasks(await window.agenthr.listTasks('all')); setEvents(await window.agenthr.listRecruitmentEvents())
    }
  }
  async function fillQuickPrompt(prompt: string) { await navigate('chat'); await window.agenthr.insertDshPrompt(prompt) }
  async function setBrowserMode(mode: BrowserMode) { await window.agenthr.setBrowserMode(mode) }
  async function openRecruitmentBrowser(mode: BrowserMode) { await window.agenthr.setRightTab('browser'); await setBrowserMode(mode) }
  async function openBrowserPage(page: 'login' | 'recommend' | 'messages') { await window.agenthr.setRightTab('browser'); await setBrowserMode(page === 'login' ? 'fullscreen' : 'split'); await window.agenthr.openPage(page) }
  async function pickFiles() { const files = await window.agenthr.pickFiles(); if (files.length) { setWorkFiles(files); setSelectedFile(files[0].path); await window.agenthr.setRightTab('files') } }
  async function chooseWorkspace() { await window.agenthr.chooseWorkspace(); setWorkFiles(await window.agenthr.listWorkspaceFiles()); setSelectedFile(''); await window.agenthr.setRightTab('files') }
  function startResize(pane: 'nav' | 'right', start: React.PointerEvent<HTMLDivElement>) {
    start.preventDefault()
    const handle = start.currentTarget
    handle.setPointerCapture(start.pointerId)
    const move = (event: PointerEvent) => {
      const value = pane === 'nav' ? Math.min(320, Math.max(180, event.clientX)) : Math.min(1000, Math.max(420, window.innerWidth - event.clientX))
      setLayoutDraft(current => ({ ...current, [pane === 'nav' ? 'navWidth' : 'rightWidth']: value }))
      void window.agenthr.setPaneLayout(pane === 'nav' ? { navWidth: value } : { rightWidth: value }).catch(e => setError(String(e)))
    }
    const finish = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish); handle.removeEventListener('lostpointercapture', finish); setLayoutDraft({}) }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', finish)
    handle.addEventListener('lostpointercapture', finish)
  }

  const shell = status.shell ?? { browserMode: 'collapsed' as const, rightTab: 'browser' as const, browserControl: 'agent' as const, workspaceTab: 'chat' as const, navWidth: 216, navCollapsed: false, rightWidth: 520 }
  const browserMode = shell.browserMode, platform = status.browser?.platform ?? 'liepin', dshPhase = status.dsh?.phase ?? 'unconfigured'
  const dshLabel = { unconfigured: '未配置', starting: '启动中', ready: '已连接', stopped: '已停止', failed: '连接失败' }[dshPhase]
  const activeJob = jobList.jobs.find(job => job.id === jobList.activeId), pendingReviews = assessments.filter(card => card.reviewStatus !== 'reviewed').length
  const page = pageTitles[activeNav]
  const rightPaneWidth = Math.min(Math.max(420, layoutDraft.rightWidth ?? shell.rightWidth), Math.max(0, window.innerWidth - (layoutDraft.navWidth ?? shell.navWidth) - 320))
  const drawerStyle = browserMode === 'split' ? { width: rightPaneWidth } : browserMode === 'fullscreen' ? { left: layoutDraft.navWidth ?? shell.navWidth, width: `calc(100vw - ${layoutDraft.navWidth ?? shell.navWidth}px)` } : undefined
  const workspaceStyle = browserMode === 'split' ? { marginRight: rightPaneWidth } : undefined

  const file = workFiles.find(item => item.path === selectedFile) ?? workFiles[0]
  return <div className={`app-shell browser-${browserMode} ${shell.navCollapsed ? 'nav-collapsed' : ''}`} style={{ '--nav-width': `${layoutDraft.navWidth ?? shell.navWidth}px` } as React.CSSProperties}>
    <aside className="sidebar"><div className="sidebar-top-drag" />
      <div className="brand"><span className="brand-mark"><Sparkle weight="fill" /></span><span className="brand-name">AgentHR</span><IconButton className="nav-collapse" aria-label={shell.navCollapsed ? '展开导航' : '收起导航'} title={shell.navCollapsed ? '展开导航' : '收起导航'} onClick={() => void run(() => window.agenthr.setPaneLayout({ navCollapsed: !shell.navCollapsed }))}><SidebarSimple size={17} /></IconButton></div>
      <nav aria-label="主导航"><div className="nav-group-label">工作空间</div>{navItems.slice(0, 5).map(item => <button key={item.id} title={item.label} aria-label={item.label} aria-current={activeNav === item.id ? 'page' : undefined} className={activeNav === item.id ? 'active' : ''} onClick={() => void run(() => navigate(item.id))}><item.icon size={18} weight={activeNav === item.id ? 'fill' : 'regular'} /><span>{item.label}</span>{item.id === 'records' && pendingReviews > 0 && <b>{pendingReviews}</b>}</button>)}<div className="nav-group-label account-label">系统</div>{navItems.slice(5).map(item => <button key={item.id} title={item.label} aria-label={item.label} aria-current={activeNav === item.id ? 'page' : undefined} className={activeNav === item.id ? 'active' : ''} onClick={() => void run(() => navigate(item.id))}><item.icon size={18} weight={activeNav === item.id ? 'fill' : 'regular'} /><span>{item.label}</span></button>)}</nav>
      <div className="sidebar-footer"><span className={`status-light ${dshPhase}`} /><div><strong>DSH {dshLabel}</strong><small>{activeJob ? activeJob.role : '尚未选择岗位'}</small></div></div>
    </aside>{!shell.navCollapsed && <div className="pane-resize nav-resize" role="separator" aria-label="拖拽调整导航栏宽度" aria-orientation="vertical" onPointerDown={event => startResize('nav', event)} />}
    <div className="shell-chrome"><div className="shell-chrome-context"><span>{page.title}</span>{activeJob && <small title={activeJob.role}>当前岗位：{activeJob.role}</small>}</div><div className="shell-chrome-actions">{error && <IconButton className="chrome-error" title={error} aria-label="关闭错误提示" onClick={() => setError('')}><WarningCircle size={17} /></IconButton>}<IconButton className="chrome-icon" aria-label={browserMode === 'fullscreen' ? '退出专注视图' : '专注右侧面板'} title={browserMode === 'fullscreen' ? '退出专注视图' : '专注右侧面板'} disabled={browserMode === 'collapsed'} onClick={() => void run(() => setBrowserMode(browserMode === 'fullscreen' ? 'split' : 'fullscreen'))}>{browserMode === 'fullscreen' ? <ArrowsInSimple size={18} /> : <ArrowsOutSimple size={18} />}</IconButton><IconButton className="chrome-icon" aria-label="收起右侧面板" title="收起右侧面板" disabled={browserMode === 'collapsed'} onClick={() => void run(() => setBrowserMode('collapsed'))}><SquaresFour size={18} /></IconButton><IconButton className={`chrome-icon ${browserMode !== 'collapsed' ? 'active' : ''}`} aria-label={browserMode === 'collapsed' ? '展开右侧面板' : '切换右侧面板'} title={browserMode === 'collapsed' ? '展开右侧面板' : '切换右侧面板'} onClick={() => void run(() => browserMode === 'collapsed' ? window.agenthr.setRightTab(shell.rightTab) : window.agenthr.setRightTab(shell.rightTab === 'files' ? 'browser' : 'files'))}><SidebarSimple size={19} /></IconButton></div></div>
    <main className="workspace" style={workspaceStyle}>
      {activeNav !== 'chat' && <section className="page-header"><div><h1>{page.title}</h1><p>{page.subtitle}</p></div></section>}
      {activeNav === 'chat' && dshPhase !== 'ready' && <div className="empty-state chat-state"><Sparkle size={26} weight="duotone" /><h2>正在准备 AI 工作台</h2><p>{status.dsh?.detail || 'DSH 就绪后，对话会在这里出现。你也可以先维护岗位。'}</p>{(dshPhase === 'failed' || dshPhase === 'stopped' || dshPhase === 'unconfigured') && <button onClick={() => void run(() => window.agenthr.restartDsh())}>重试 Agent</button>}<button onClick={() => void run(() => navigate('jobs'))}>前往岗位管理</button></div>}
      {activeNav === 'jobs' && <JobPage busy={busy} jobList={jobList} jobBrief={jobBrief} criteriaInput={criteriaInput} saved={jobBriefSaved} isNew={newJob} activeJob={activeJob} setJobBrief={setJobBrief} setCriteriaInput={setCriteriaInput} setSaved={setJobBriefSaved} applyJobList={applyJobList} setNewJob={setNewJob} run={run} fillQuickPrompt={fillQuickPrompt} />}
      {activeNav === 'talent' && <TalentPage candidates={talentPool} setCandidates={setTalentPool} resume={resume} setResume={setResume} run={run} setBrowserMode={openRecruitmentBrowser} />}
      {activeNav === 'tasks' && <TaskPage activeJob={activeJob} jobs={jobList.jobs} platform={platform} tasks={tasks} setTasks={setTasks} workFiles={workFiles} run={run} openAgent={async (id, mode) => { await window.agenthr.workOnTask(id, mode); await navigate('chat') }} />}
      {activeNav === 'records' && <RecordsPage assessments={assessments} events={events} scope={assessmentScope} setScope={setAssessmentScope} setAssessments={setAssessments} run={run} />}
      {activeNav === 'accounts' && <AccountPage status={status} platform={platform} control={shell.browserControl} run={run} setBrowserMode={openRecruitmentBrowser} />}
      {activeNav === 'settings' && <div className="content-scroll narrow"><section className="surface settings-list"><h2>运行与安全</h2><div className="workspace-setting"><span>本地工作目录</span><span className="workspace-path" title={status.workspace?.path}>{status.workspace?.path || '尚未设置'}</span><button className="secondary-button" onClick={() => void run(chooseWorkspace)}>更改目录</button></div><div><span>AI 运行时</span><strong>DSH {dshLabel}</strong></div><div><span>招聘网站会话</span><strong>本机独立保存</strong></div><div><span>页面隔离</span><strong>Sandbox + Context Isolation</strong></div><div><span>下载与文件写入</span><strong>需要用户授权</strong></div><div><span>外部消息</span><strong>默认禁止自动发送</strong></div>{status.dsh?.detail && <p>{status.dsh.detail}</p>}</section></div>}
    </main>
    {browserMode === 'split' && <div className="pane-resize right-resize" role="separator" aria-label="拖拽调整右侧面板宽度" aria-orientation="vertical" style={{ right: rightPaneWidth }} onPointerDown={event => startResize('right', event)} />}
    {browserMode !== 'collapsed' && <aside className={`browser-drawer ${browserMode}`} style={drawerStyle}><div className="browser-toolbar"><div className="right-tab-strip" role="tablist" aria-label="右侧工作区"><IconButton role="tab" aria-selected={shell.rightTab === 'files'} className={shell.rightTab === 'files' ? 'active' : ''} aria-label="文件" title="文件" onClick={() => void run(() => window.agenthr.setRightTab('files'))}><FolderOpen size={19} /></IconButton><IconButton role="tab" aria-selected={shell.rightTab === 'browser'} className={shell.rightTab === 'browser' ? 'active' : ''} aria-label="浏览器" title="浏览器" onClick={() => void run(() => window.agenthr.setRightTab('browser'))}><Browsers size={19} /></IconButton></div><div className="right-tab-title"><strong>{shell.rightTab === 'files' ? status.workspace?.name || '工作文件' : status.browser?.title || (platform === 'boss' ? 'BOSS 直聘' : '猎聘企业端')}</strong>{shell.rightTab === 'files' ? <small title={status.workspace?.path}>{status.workspace?.path || '尚未设置工作目录'}</small> : <small title={browserActivity(status.browser, shell.browserControl)}>{platform === 'boss' ? 'BOSS 直聘' : '猎聘'} · {browserActivity(status.browser, shell.browserControl)}</small>}</div><div className="browser-controls">{shell.rightTab === 'files' ? <><IconButton aria-label="导入文件" title="导入文件到工作目录" onClick={() => void run(pickFiles)}><Plus size={17} /></IconButton><IconButton aria-label="选择工作目录" title="选择工作目录" onClick={() => void run(chooseWorkspace)}><FolderOpen size={17} /></IconButton></> : <><IconButton className="platform-switch" aria-label={platform === 'boss' ? '切换至猎聘' : '切换至 BOSS 直聘'} title={busy ? '正在处理，请稍候' : status.browser?.lastAction?.result === 'running' ? 'Agent 正在操作，请等待动作结束后切换平台' : `当前：${platform === 'boss' ? 'BOSS 直聘' : '猎聘'}；点击切换至${platform === 'boss' ? '猎聘' : 'BOSS 直聘'}`} disabled={busy || status.browser?.lastAction?.result === 'running'} onClick={() => void run(() => window.agenthr.selectPlatform(platform === 'boss' ? 'liepin' : 'boss'))}><ArrowsLeftRight size={17} /></IconButton><span className="browser-page-shortcuts" aria-label="招聘页面"><IconButton aria-label="登录页" title="登录页" onClick={() => void run(() => openBrowserPage('login'))}><SignIn size={16} /></IconButton><IconButton aria-label="候选人页" title="候选人页" onClick={() => void run(() => openBrowserPage('recommend'))}><UserList size={16} /></IconButton><IconButton aria-label="沟通页" title={platform === 'liepin' ? '猎聘沟通页尚未配置' : '沟通页'} disabled={platform === 'liepin'} onClick={() => void run(() => openBrowserPage('messages'))}><ChatCircleDots size={16} /></IconButton></span><IconButton className={shell.browserControl === 'human' ? 'takeover active' : 'takeover'} aria-label={shell.browserControl === 'human' ? '交还 Agent' : '人工接管'} title={shell.browserControl === 'human' ? '交还 Agent' : '人工接管'} onClick={() => void run(() => window.agenthr.setBrowserControl(shell.browserControl === 'human' ? 'agent' : 'human'))}>{shell.browserControl === 'human' ? <Play size={16} /> : <Pause size={16} />}</IconButton></>}<IconButton aria-label={browserMode === 'fullscreen' ? '退出全屏' : '放大右侧面板'} title={browserMode === 'fullscreen' ? '退出全屏' : '放大右侧面板'} onClick={() => void run(() => setBrowserMode(browserMode === 'fullscreen' ? 'split' : 'fullscreen'))}>{browserMode === 'fullscreen' ? <ArrowsInSimple size={17} /> : <ArrowsOutSimple size={17} />}</IconButton><IconButton aria-label="收起右侧面板" title="收起右侧面板" onClick={() => void run(() => setBrowserMode('collapsed'))}><X size={17} /></IconButton></div></div>{shell.rightTab === 'files' && <div className="file-panel" role="tabpanel"><div className="file-list">{workFiles.length === 0 ? <div className="file-empty"><FolderOpen size={28} /><strong>工作目录中还没有文件</strong><p>导入 JD、附件或备注，之后的下载也会保存到这里。</p><button onClick={() => void run(pickFiles)}><Plus size={15} />导入文件</button></div> : workFiles.map(item => <button key={item.path} className={file?.path === item.path ? 'active' : ''} title={item.path} onClick={() => setSelectedFile(item.path)}><FileText size={17} /><span>{item.path}</span></button>)}</div>{file && <div className="file-preview"><div><strong>{file.name}</strong><small>{Math.ceil(file.size / 1024)} KB · {file.path}</small></div>{file.previewable ? <pre>{file.content}</pre> : <div className="binary-preview"><FileText size={30} /><strong>此文件暂不支持内嵌预览</strong><p>文件已保存在本地工作目录中。</p></div>}</div>}</div>}</aside>}
  </div>
}

function browserActivity(browser: AgentHrStatus['browser'], control: 'agent' | 'human'): string {
  if (browser?.error) return browser.error
  if (!browser?.lastAction) return control === 'human' ? '人工控制' : 'Agent 控制'
  const action = { fill: '填写', press_enter: '确认输入', click: '点击', scroll_up: '向上滚动', scroll_down: '向下滚动', open_candidate: '打开候选人', greet_candidate: '打招呼' }[browser.lastAction.action] ?? browser.lastAction.action
  const result = { running: '执行中', succeeded: '已完成', failed: '失败' }[browser.lastAction.result]
  return `${action} ${browser.lastAction.target} / ${result}`
}

type TalentPageProps = {
  candidates: CandidateRecord[]
  setCandidates: (value: CandidateRecord[]) => void
  resume: OpenResume | null
  setResume: (value: OpenResume | null) => void
  run: (fn: () => Promise<void>) => Promise<void>
  setBrowserMode: (mode: BrowserMode) => Promise<void>
}

function TalentPage(p: TalentPageProps) {
  const [selectedId, setSelectedId] = useState('')
  const [draft, setDraft] = useState<CandidateRecord | null>(null)
  const [mergeTargetId, setMergeTargetId] = useState('')
  const [confirmingMerge, setConfirmingMerge] = useState(false)
  const [pendingStage, setPendingStage] = useState<{ candidateId: string; stage: CandidateRecord['stage'] } | null>(null)
  const selected = p.candidates.find(candidate => candidate.id === selectedId) ?? p.candidates[0] ?? null

  useEffect(() => {
    if (!selected) { setSelectedId(''); setDraft(null); return }
    if (selected.id !== selectedId) setSelectedId(selected.id)
    setDraft(selected)
    setMergeTargetId('')
    setConfirmingMerge(false)
  }, [selected?.id, selected?.updatedAt])

  async function refresh() { p.setCandidates(await window.agenthr.listCandidates('active')) }
  function update<K extends keyof CandidateRecord>(key: K, value: CandidateRecord[K]) {
    if (draft) setDraft({ ...draft, [key]: value })
  }

  return <div className="content-scroll"><div className="content-grid talent-layout">
    <section className="surface talent-list-surface">
      <div className="surface-head"><div><span>当前岗位</span><h2>人才库</h2></div><button className="secondary-button" onClick={() => void p.run(async () => { await p.setBrowserMode('split'); p.setCandidates(await window.agenthr.captureVisibleCandidates()) })}>保存当前页线索</button></div>
      {p.candidates.length === 0 ? <Empty icon={UsersThree} title="还没有候选人线索" body="打开招聘浏览器，进入推荐页后把当前卡片保存到人才库。" /> : <div className="candidate-rows">{p.candidates.map(candidate => <article className={selected?.id === candidate.id ? 'selected' : ''} key={candidate.id}>
        <button className="candidate-main" onClick={() => { setSelectedId(candidate.id); setPendingStage(null) }}><span className="avatar">{candidate.displayName.slice(0, 1)}</span><span><strong>{candidate.displayName}</strong><small>{candidate.currentTitle || '等待读取完整简历'}</small></span></button>
        <div className="candidate-actions"><span className="row-meta">{candidate.sourcePlatforms.map(value => value === 'boss' ? 'BOSS' : '猎聘').join(' + ')}</span><select aria-label={`${candidate.displayName}的招聘阶段`} value={candidate.stage} onChange={event => { setSelectedId(candidate.id); setPendingStage({ candidateId: candidate.id, stage: event.target.value as CandidateRecord['stage'] }) }}><option value="lead">线索</option><option value="screening">筛选</option><option value="interview">面试</option><option value="offer">Offer</option><option value="hired">已录用</option><option value="rejected">已淘汰</option></select></div>
      </article>)}</div>}
    </section>
    <section className="surface candidate-detail">
      {!draft || !selected ? <Empty icon={UserList} title="选择一名候选人" body="在左侧选择候选人后，可以精确编辑资料、备注和标签。" /> : <>
        <div className="surface-head"><div><span>候选人详情</span><h2>{draft.displayName}</h2></div><span className="source-count">{selected.sourceCount} 个来源</span></div>
        {pendingStage?.candidateId === selected.id && <div className="change-preview"><WarningCircle size={18} /><div><strong>确认修改招聘阶段</strong><p>{stageLabel(selected.stage)} → {stageLabel(pendingStage.stage)}。此变更会进入招聘记录。</p></div><button className="secondary-button" onClick={() => setPendingStage(null)}>取消</button><button className="primary-button" onClick={() => void p.run(async () => { await window.agenthr.setCandidateStage(selected.id, pendingStage.stage, selected.updatedAt); setPendingStage(null); await refresh() })}>确认修改</button></div>}
        <div className="form-field-grid"><div><label htmlFor="candidate-name">姓名</label><input id="candidate-name" value={draft.displayName} onChange={event => update('displayName', event.target.value)} /></div><div><label htmlFor="candidate-location">所在地</label><input id="candidate-location" value={draft.location} placeholder="未填写" onChange={event => update('location', event.target.value)} /></div></div>
        <div className="form-field-grid"><div><label htmlFor="candidate-company">当前公司</label><input id="candidate-company" value={draft.currentCompany} placeholder="未填写" onChange={event => update('currentCompany', event.target.value)} /></div><div><label htmlFor="candidate-title">当前职位</label><input id="candidate-title" value={draft.currentTitle} placeholder="未填写" onChange={event => update('currentTitle', event.target.value)} /></div></div>
        <div className="form-field-grid"><div><label htmlFor="candidate-position">期望职位</label><input id="candidate-position" value={draft.expectedPosition} placeholder="未填写" onChange={event => update('expectedPosition', event.target.value)} /></div><div><label htmlFor="candidate-salary">期望薪资</label><input id="candidate-salary" value={draft.expectedSalary} placeholder="未填写" onChange={event => update('expectedSalary', event.target.value)} /></div></div>
        <label htmlFor="candidate-tags">标签</label><input id="candidate-tags" value={draft.tags.join('，')} placeholder="用逗号分隔，最多 20 个" onChange={event => update('tags', event.target.value.split(/[，,]/u).map(item => item.trim()).filter(Boolean))} />
        <label htmlFor="candidate-notes">招聘备注</label><textarea id="candidate-notes" value={draft.notes} placeholder="记录人工判断、面试反馈或下一步信息。" onChange={event => update('notes', event.target.value)} />
        <div className="candidate-detail-actions"><button className="secondary-button" onClick={() => void p.run(async () => { await p.setBrowserMode('split'); p.setResume(await window.agenthr.readOpenResume()) })}>读取当前简历</button><button className="primary-button" onClick={() => void p.run(async () => { await window.agenthr.updateCandidate(selected.id, selected.updatedAt, { displayName: draft.displayName, currentCompany: draft.currentCompany, currentTitle: draft.currentTitle, location: draft.location, expectedSalary: draft.expectedSalary, expectedPosition: draft.expectedPosition, tags: draft.tags, notes: draft.notes }); await refresh() })}>保存资料</button></div>
        {p.resume && <details className="resume-disclosure"><summary>{p.resume.name || '当前简历'}的页面快照</summary><div className="resume-export"><span>保存后可在右侧文件栏及 DSH 当前工作目录中使用。</span><button className="secondary-button" onClick={() => void p.run(async () => { await window.agenthr.saveOpenResume(selected.id); await window.agenthr.setRightTab('files') })}>保存到工作目录</button></div><pre>{p.resume.text}</pre></details>}
        <div className="merge-area"><span className="section-label">人工合并</span><p>只在确认两个来源属于同一人时使用。来源、岗位关联、标签和备注会合并到当前候选人。</p><div className="field-row"><select aria-label="选择重复候选人" value={mergeTargetId} onChange={event => { setMergeTargetId(event.target.value); setConfirmingMerge(false) }}><option value="">选择重复记录</option>{p.candidates.filter(candidate => candidate.id !== selected.id).map(candidate => <option value={candidate.id} key={candidate.id}>{candidate.displayName}（{candidate.sourcePlatforms.join(' + ')}）</option>)}</select><button className="danger-quiet" disabled={!mergeTargetId} onClick={() => setConfirmingMerge(true)}>准备合并</button></div>
          {confirmingMerge && mergeTargetId && <div className="merge-confirm"><WarningCircle size={18} /><div><strong>确认合并候选人？</strong><p>重复记录会被移除，此操作会写入审计记录。</p></div><button className="secondary-button" onClick={() => setConfirmingMerge(false)}>取消</button><button className="danger-button" onClick={() => void p.run(async () => { const duplicate = p.candidates.find(candidate => candidate.id === mergeTargetId); if (!duplicate) throw new Error('重复候选人已变化'); await window.agenthr.mergeCandidates({ primaryId: selected.id, duplicateId: duplicate.id, expectedPrimaryUpdatedAt: selected.updatedAt, expectedDuplicateUpdatedAt: duplicate.updatedAt, confirmed: true }); await refresh(); setConfirmingMerge(false) })}>确认合并</button></div>}
        </div>
      </>}
    </section>
  </div></div>
}

function stageLabel(stage: CandidateRecord['stage']): string {
  return { lead: '线索', screening: '筛选', interview: '面试', offer: 'Offer', hired: '已录用', rejected: '已淘汰' }[stage]
}

type TaskPageProps = { activeJob?: JobRecord; jobs: JobRecord[]; platform: Platform; tasks: RecruitmentTask[]; setTasks: (value: RecruitmentTask[]) => void; workFiles: WorkspaceFile[]; run: (fn: () => Promise<void>) => Promise<void>; openAgent: (id: string, mode: 'continue' | 'new_session') => Promise<void> }
function TaskPage(p: TaskPageProps) {
  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState<RecruitmentTaskDetail | null>(null)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ title: '', description: '', type: 'search' as RecruitmentTask['type'], platform: p.platform as Platform | '', jobId: p.activeJob?.id ?? '', workspacePaths: [] as string[] })
  const [note, setNote] = useState('')
  const selected = p.tasks.find(task => task.id === selectedId) ?? p.tasks[0] ?? null
  useEffect(() => {
    if (creating) return
    if (!selected) { setSelectedId(''); setDetail(null); return }
    if (selected.id !== selectedId) setSelectedId(selected.id)
    void window.agenthr.getTask(selected.id).then(setDetail)
  }, [selected?.id, selected?.updatedAt, creating])

  async function refresh(id?: string) {
    const tasks = await window.agenthr.listTasks('all')
    p.setTasks(tasks)
    const target = id ?? selectedId
    if (target) { setSelectedId(target); setDetail(await window.agenthr.getTask(target)) }
  }
  async function setStatus(task: RecruitmentTask, status: RecruitmentTask['status']) {
    await window.agenthr.setTaskStatus(task.id, status, task.updatedAt)
    await refresh(task.id)
  }
  async function createTask() {
    const task = await window.agenthr.createTask({ ...draft, platform: draft.platform || null, jobId: draft.jobId || null })
    setCreating(false); setDraft({ title: '', description: '', type: 'search', platform: p.platform, jobId: p.activeJob?.id ?? '', workspacePaths: [] })
    await refresh(task.id)
  }
  function toggleFile(path: string) {
    setDraft(value => ({ ...value, workspacePaths: value.workspacePaths.includes(path) ? value.workspacePaths.filter(item => item !== path) : [...value.workspacePaths, path] }))
  }
  const statusCounts = p.tasks.reduce((counts, task) => ({ ...counts, [task.status]: (counts[task.status] ?? 0) + 1 }), {} as Record<string, number>)
  return <div className="content-scroll"><div className="task-workspace">
    <aside className="surface task-index">
      <div className="task-index-head"><div><h2>任务</h2><span>{p.tasks.length} 个</span></div><button className="primary-button" onClick={() => { setCreating(true); setDetail(null) }}><Plus size={14} />新建</button></div>
      <div className="task-index-summary"><span>{statusCounts.running ?? 0} 执行中</span><span>{statusCounts.queued ?? 0} 待开始</span><span>{statusCounts.completed ?? 0} 已完成</span></div>
      <div className="task-index-list">{p.tasks.map(task => <button key={task.id} className={!creating && selected?.id === task.id ? 'active' : ''} onClick={() => { setCreating(false); setSelectedId(task.id) }}><span className={`task-state-mark ${task.status}`}><ListChecks size={14} /></span><span><strong>{task.title}</strong><small>{taskStatusLabel(task.status)}{task.platform ? ` / ${task.platform === 'boss' ? 'BOSS' : '猎聘'}` : ''}</small></span></button>)}</div>
      {p.tasks.length === 0 && !creating && <Empty icon={ListChecks} title="还没有任务" body="创建任务后，输入、执行记录和产出都会保存在同一个明细中。" />}
    </aside>
    <section className="surface task-detail-surface">{creating ? <div className="task-create">
      <div className="task-detail-head"><div><span>新任务</span><h2>定义要完成的工作</h2></div><button className="text-button" onClick={() => setCreating(false)}>取消</button></div>
      <label htmlFor="task-title">任务标题</label><input id="task-title" maxLength={200} value={draft.title} placeholder="例如：整理上海 Java 候选人并对比岗位要求" onChange={event => setDraft({ ...draft, title: event.target.value })} />
      <label htmlFor="task-description">明确输入</label><textarea id="task-description" className="task-description-input" maxLength={8000} value={draft.description} placeholder="写清目标、范围、筛选条件、需要浏览的数据以及期望产出。Agent 会把这段内容作为任务的原始上下文。" onChange={event => setDraft({ ...draft, description: event.target.value })} />
      <div className="task-create-fields"><div><label htmlFor="task-type">任务类型</label><select id="task-type" value={draft.type} onChange={event => setDraft({ ...draft, type: event.target.value as RecruitmentTask['type'] })}><option value="search">搜索候选人</option><option value="analyze">分析资料</option><option value="confirm">人工确认</option><option value="follow_up">后续跟进</option></select></div><div><label htmlFor="task-job">关联岗位</label><select id="task-job" value={draft.jobId} onChange={event => setDraft({ ...draft, jobId: event.target.value })}><option value="">不关联岗位</option>{p.jobs.map(job => <option value={job.id} key={job.id}>{job.role}</option>)}</select></div><div><label htmlFor="task-platform">招聘平台</label><select id="task-platform" value={draft.platform} onChange={event => setDraft({ ...draft, platform: event.target.value as Platform | '' })}><option value="">不限平台</option><option value="boss">BOSS 直聘</option><option value="liepin">猎聘</option></select></div></div>
      <div className="task-file-picker"><div><strong>关联工作文件</strong><span>可选，Agent 会在任务详情中看到这些文件</span></div>{p.workFiles.length ? <div className="task-file-options">{p.workFiles.slice(0, 30).map(file => <label key={file.path}><input type="checkbox" checked={draft.workspacePaths.includes(file.path)} onChange={() => toggleFile(file.path)} /><FileText size={15} /><span>{file.path}</span></label>)}</div> : <p>当前工作目录中没有可关联文件。</p>}</div>
      <div className="task-create-footer"><p>创建任务只保存计划，不会立即向候选人发送消息。</p><button className="primary-button" disabled={!draft.title.trim() || !draft.description.trim()} onClick={() => void p.run(createTask)}>创建任务</button></div>
    </div> : detail ? <TaskDetail detail={detail} jobs={p.jobs} run={p.run} setStatus={setStatus} refresh={refresh} note={note} setNote={setNote} openAgent={p.openAgent} /> : <Empty icon={ListChecks} title="选择一个任务" body="查看原始输入、执行记录、浏览器结果和关联文件。" />}</section>
  </div></div>
}

function TaskDetail(p: { detail: RecruitmentTaskDetail; jobs: JobRecord[]; run: TaskPageProps['run']; setStatus: (task: RecruitmentTask, status: RecruitmentTask['status']) => Promise<void>; refresh: (id?: string) => Promise<void>; note: string; setNote: (value: string) => void; openAgent: TaskPageProps['openAgent'] }) {
  const task = p.detail.task, job = p.jobs.find(item => item.id === task.jobId)
  const kindLabel = { analysis: 'Agent 分析', browser_result: '浏览器结果', note: '人工备注' }
  return <div className="task-detail">
    <div className="task-detail-head"><div><span>{taskStatusLabel(task.status)}</span><h2>{task.title}</h2><p>{task.type === 'search' ? '搜索候选人' : task.type === 'analyze' ? '分析资料' : task.type === 'confirm' ? '人工确认' : '后续跟进'}{task.platform ? ` / ${task.platform === 'boss' ? 'BOSS 直聘' : '猎聘'}` : ''}</p></div><div className="task-detail-actions"><button className="secondary-button" onClick={() => void p.run(() => p.openAgent(task.id, 'continue'))}><ChatCircleDots size={15} />继续任务</button><button className="primary-button" onClick={() => void p.run(() => p.openAgent(task.id, 'new_session'))}><Plus size={15} />新对话分析</button></div></div>
    <div className="task-context-grid"><section><span>任务输入</span><p>{task.description}</p></section><aside><div><span>关联岗位</span><strong>{job?.role || '未关联岗位'}</strong></div><div><span>执行次数</span><strong>{task.runCount}</strong></div><div><span>最近更新</span><strong>{new Date(task.updatedAt).toLocaleString()}</strong></div>{task.lastBrowserUrl && <div><span>最近页面</span><strong className="task-url" title={task.lastBrowserUrl}>{task.lastBrowserUrl}</strong></div>}</aside></div>
    {p.detail.files.length > 0 && <div className="task-resources"><div><strong>关联文件</strong><span>{p.detail.files.length} 个</span></div><div className="task-resource-list">{p.detail.files.map(file => <button key={`${file.kind}-${file.path}`} title={file.path} onClick={() => void window.agenthr.setRightTab('files')}><FileText size={16} /><span>{file.path}</span><small>{file.kind === 'input' ? '输入' : '产出'}</small></button>)}</div></div>}
    {task.errorMessage && <div className="task-detail-error"><WarningCircle size={17} /><div><strong>{task.errorCode || '任务执行失败'}</strong><p>{task.errorMessage}</p></div></div>}
    <div className="task-timeline-head"><div><h3>执行记录</h3><span>{p.detail.entries.length} 条</span></div><div>{task.status === 'running' && <button className="secondary-button" onClick={() => void p.run(() => p.setStatus(task, 'paused'))}>暂停</button>}{task.status === 'paused' && <button className="secondary-button" onClick={() => void p.run(() => p.setStatus(task, 'running'))}>恢复</button>}{task.status !== 'completed' && task.status !== 'cancelled' && <button className="secondary-button" onClick={() => void p.run(() => p.setStatus(task, 'completed'))}>标记完成</button>}</div></div>
    <div className="task-timeline"><article className="task-entry input"><span className="task-entry-icon"><UserList size={15} /></span><div><header><strong>用户输入</strong><time>{new Date(task.createdAt).toLocaleString()}</time></header><p>{task.description}</p></div></article>{p.detail.entries.map(entry => <article className={`task-entry ${entry.kind}`} key={entry.id}><span className="task-entry-icon">{entry.kind === 'browser_result' ? <Browsers size={15} /> : entry.kind === 'analysis' ? <Sparkle size={15} /> : <FileText size={15} />}</span><div><header><span>{kindLabel[entry.kind]}</span><strong>{entry.title}</strong><time>{new Date(entry.createdAt).toLocaleString()}</time></header><p>{entry.content}</p>{entry.sourceUrl && <a href={entry.sourceUrl} onClick={event => event.preventDefault()} title={entry.sourceUrl}>{entry.sourceUrl}</a>}</div></article>)}</div>
    {p.detail.entries.length === 0 && <div className="task-no-results"><Sparkle size={20} /><div><strong>等待执行结果</strong><p>继续任务后，Agent 的分析和浏览器发现会写回这里。</p></div></div>}
    <div className="task-note-composer"><textarea value={p.note} maxLength={20_000} placeholder="补充人工判断、范围调整或下一步要求" onChange={event => p.setNote(event.target.value)} /><button className="secondary-button" disabled={!p.note.trim()} onClick={() => void p.run(async () => { await window.agenthr.addTaskNote(task.id, { title: '人工补充', content: p.note }); p.setNote(''); await p.refresh(task.id) })}>添加备注</button></div>
  </div>
}

function taskStatusLabel(status: RecruitmentTask['status']): string {
  return { queued: '等待执行', running: '执行中', paused: '已暂停', completed: '已完成', failed: '执行失败', cancelled: '已取消' }[status]
}

type AccountPageProps = { status: AgentHrStatus; platform: Platform; control: 'agent' | 'human'; run: (fn: () => Promise<void>) => Promise<void>; setBrowserMode: (mode: BrowserMode) => Promise<void> }
function AccountPage(p: AccountPageProps) {
  const [validations, setValidations] = useState<PlatformValidationRecord[]>([])
  useEffect(() => { void window.agenthr.listPlatformValidations().then(setValidations) }, [])
  async function validate(check: PlatformValidationRecord['check']) {
    await window.agenthr.validatePlatform(check)
    setValidations(await window.agenthr.listPlatformValidations())
  }
  const latest = validations.find(record => record.platform === p.platform)
  const passedRuns = new Set(validations.filter(record => record.platform === p.platform && record.check === 'candidate_list' && record.status === 'passed').map(record => record.runId)).size
  return <div className="content-scroll narrow"><div className="account-grid">{([['liepin', '猎聘企业端'], ['boss', 'BOSS 直聘']] as const).map(([id, name]) => {
    const record = validations.find(item => item.platform === id)
    return <section className={`surface account-card ${p.platform === id ? 'current' : ''}`} key={id}><div><span className="platform-mark">{id === 'boss' ? 'B' : '猎'}</span><div><h2>{name}</h2><p>{record?.status === 'passed' ? '只读流程已验证' : p.platform === id && p.status.browser?.url ? '会话已载入' : '本机独立会话'}</p></div></div><button className="secondary-button" onClick={() => void p.run(async () => { await window.agenthr.selectPlatform(id); await p.setBrowserMode('fullscreen') })}>{p.platform === id ? '打开' : '切换并打开'}</button></section>
  })}</div>
    <section className="surface control-card"><div><span className="section-label">页面控制权</span><h2>{p.control === 'human' ? '你正在操作浏览器' : 'Agent 可以操作浏览器'}</h2><p>人工接管后，Agent 的页面动作会暂停。登录、验证码和复杂筛选完成后，再交还控制权。</p></div><button className={p.control === 'human' ? 'primary-button' : 'secondary-button'} onClick={() => void p.run(() => window.agenthr.setBrowserControl(p.control === 'human' ? 'agent' : 'human'))}>{p.control === 'human' ? <><Play size={15} />交还 Agent</> : <><Pause size={15} />人工接管</>}</button></section>
    <section className="surface validation-card"><div className="surface-head"><div><span>真实平台验收</span><h2>{p.platform === 'boss' ? 'BOSS 直聘' : '猎聘企业端'}</h2></div>{passedRuns > 1 && <span className="validation-passed"><CheckCircle weight="fill" />登录保持已复验</span>}</div><p>先完成登录并进入推荐页。首次通过后重启 AgentHR，不重新登录并再次验证，即可确认会话保持。记录不保存 Cookie、简历正文或候选人姓名。</p><div className="validation-actions"><button className="secondary-button" onClick={() => void p.run(() => validate('candidate_list'))}>验证候选人列表</button><button className="secondary-button" onClick={() => void p.run(() => validate('resume_detail'))}>验证当前简历</button></div>{latest ? <div className={`validation-result ${latest.status}`}><span>{latest.status === 'passed' ? <CheckCircle weight="fill" /> : <WarningCircle weight="fill" />}</span><div><strong>{latest.status === 'passed' ? '最近验证通过' : '最近验证未通过'}</strong><p>{latest.summary}</p><small>{new Date(latest.createdAt).toLocaleString()}</small></div></div> : <div className="validation-empty">尚无真实平台验收记录</div>}<div className="validation-history">{validations.filter(record => record.platform === p.platform).slice(0, 6).map(record => <div key={record.id}><span>{record.check === 'candidate_list' ? '候选人列表' : '简历详情'}</span><strong className={record.status}>{record.status === 'passed' ? '通过' : '未通过'}</strong><time>{new Date(record.createdAt).toLocaleString()}</time></div>)}</div></section>
  </div>
}

type JobPageProps = { busy: boolean; jobList: JobList; jobBrief: JobBrief; criteriaInput: string; saved: boolean; isNew: boolean; activeJob?: JobRecord; setJobBrief: React.Dispatch<React.SetStateAction<JobBrief>>; setCriteriaInput: (v: string) => void; setSaved: (v: boolean) => void; applyJobList: (v: JobList) => void; setNewJob: (v: boolean) => void; run: (fn: () => Promise<void>) => Promise<void>; fillQuickPrompt: (v: string) => Promise<void> }
function JobPage(p: JobPageProps) {
  const [pendingSave, setPendingSave] = useState<JobBrief | null>(null)
  const [query, setQuery] = useState('')
  const [pendingNavigation, setPendingNavigation] = useState<{ kind: 'job'; id: string } | { kind: 'new' } | null>(null)
  useEffect(() => { setPendingSave(null); setPendingNavigation(null) }, [p.jobList.activeId, p.isNew])
  const update = <K extends keyof JobBrief>(key: K, value: JobBrief[K]) => { p.setJobBrief({ ...p.jobBrief, [key]: value }); p.setSaved(false); setPendingSave(null) }
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleJobs = p.jobList.jobs.filter(job => !normalizedQuery || [job.role, job.location, job.salaryRange].some(value => value.toLocaleLowerCase().includes(normalizedQuery)))
  const statusLabel: Record<JobRecord['status'], string> = { draft: '草稿', open: '招聘中', paused: '已暂停', closed: '已关闭' }
  const hasUnsavedContent = !p.saved && Boolean(p.jobBrief.role.trim() || p.jobBrief.requirements.trim() || p.criteriaInput.trim())
  async function navigateJob(target: { kind: 'job'; id: string } | { kind: 'new' }) {
    if (target.kind === 'job') {
      const record = await window.agenthr.activateJob(target.id)
      p.setJobBrief(toJobBrief(record)); p.setCriteriaInput(record.criteria.join('\n')); p.applyJobList(await window.agenthr.listJobs()); p.setNewJob(false); p.setSaved(true)
    } else {
      await window.agenthr.clearActiveJob(); p.applyJobList(await window.agenthr.listJobs()); p.setJobBrief(emptyJob); p.setCriteriaInput(''); p.setNewJob(true); p.setSaved(false)
    }
    setPendingNavigation(null)
  }
  function requestNavigation(target: { kind: 'job'; id: string } | { kind: 'new' }) {
    if (target.kind === 'job' && target.id === p.jobList.activeId && !p.isNew) return
    if (hasUnsavedContent) { setPendingNavigation(target); return }
    void p.run(() => navigateJob(target))
  }
  async function persist(value: JobBrief, create: boolean) {
    if (!create && !p.activeJob) throw new Error('当前岗位已变化，请刷新后重试')
    const record = create ? await window.agenthr.createJob(value) : await window.agenthr.saveJobBrief(value, p.activeJob!.updatedAt)
    p.setJobBrief(toJobBrief(record)); p.setCriteriaInput(record.criteria.join('\n')); p.applyJobList(await window.agenthr.listJobs()); p.setNewJob(false); p.setSaved(true); setPendingSave(null)
  }
  return <div className="content-scroll"><div className="content-grid job-layout"><aside className="surface job-list-panel">
    <div className="job-list-head"><div><span className="section-label">全部岗位</span><h2>岗位列表 <small>{p.jobList.jobs.length}</small></h2></div><button className="primary-button job-add" disabled={p.busy} onClick={() => requestNavigation({ kind: 'new' })}><Plus size={14} />新建</button></div>
    <label className="job-search" htmlFor="job-search"><MagnifyingGlass size={14} /><input id="job-search" type="search" value={query} placeholder="搜索岗位或地点" onChange={event => setQuery(event.target.value)} /></label>
    <div className="job-list" role="listbox" aria-label="岗位列表">{visibleJobs.map(job => <button key={job.id} role="option" aria-selected={!p.isNew && p.jobList.activeId === job.id} className={!p.isNew && p.jobList.activeId === job.id ? 'job-row active' : 'job-row'} disabled={p.busy} onClick={() => requestNavigation({ kind: 'job', id: job.id })}><span className="job-row-top"><strong>{job.role}</strong><span className={`job-status ${job.status}`}>{statusLabel[job.status]}</span></span><span className="job-row-meta"><span>{job.location || '地点未设置'}</span><span>招 {job.hiringTarget} 人</span></span></button>)}</div>
    {visibleJobs.length === 0 && <div className="job-list-empty"><Briefcase size={22} /><strong>{p.jobList.jobs.length ? '没有匹配岗位' : '还没有岗位'}</strong><span>{p.jobList.jobs.length ? '换个关键词试试' : '新建岗位后会显示在这里'}</span></div>}
    {pendingNavigation && <div className="job-navigation-warning"><WarningCircle size={16} /><div><strong>有未保存的修改</strong><span>继续切换会丢失当前修改。</span></div><button onClick={() => setPendingNavigation(null)}>取消</button><button className="danger-quiet" onClick={() => void p.run(() => navigateJob(pendingNavigation))}>放弃并切换</button></div>}
    <div className="job-list-summary"><span><strong>{p.jobList.jobs.filter(job => job.status === 'open').length}</strong> 招聘中</span><span><strong>{p.jobList.jobs.reduce((sum, job) => sum + (job.status === 'open' ? job.hiringTarget : 0), 0)}</strong> 计划招聘</span></div>
  </aside><section className="surface form-surface job-editor">
    <div className="surface-head"><div><span>{p.isNew ? '新岗位' : '岗位详情 / 编辑岗位'}</span><h2>{p.isNew ? '创建岗位草稿' : p.jobBrief.role}</h2></div><div className="job-editor-actions"><span className={`save-state ${p.saved ? 'saved' : ''}`}>{p.saved ? '已保存' : '未保存'}</span>{p.activeJob && <button className="text-button" onClick={() => void p.run(() => p.fillQuickPrompt(`请为「${p.activeJob!.role}」寻找候选人，先说明搜索计划。`))}>交给 Agent</button>}</div></div>
    <div className="job-editor-summary"><span><strong>{p.jobBrief.hiringTarget}</strong>招聘人数</span><span><strong>{p.criteriaInput.split('\n').filter(item => item.trim()).length}</strong>判断条件</span><span><strong>{p.jobBrief.location || '未设置'}</strong>工作地点</span></div>
    <label htmlFor="job-role">岗位名称</label><input id="job-role" maxLength={120} value={p.jobBrief.role} placeholder="例如：Java 后端工程师" onChange={event => update('role', event.target.value)} />
    <div className="form-field-grid"><div><label htmlFor="job-location">工作地点</label><input id="job-location" maxLength={120} value={p.jobBrief.location} placeholder="例如：上海" onChange={event => update('location', event.target.value)} /></div><div><label htmlFor="job-salary">薪资范围</label><input id="job-salary" maxLength={120} value={p.jobBrief.salaryRange} placeholder="例如：30K-45K" onChange={event => update('salaryRange', event.target.value)} /></div></div>
    <div className="form-field-grid three"><div><label htmlFor="job-employment">用工类型</label><select id="job-employment" value={p.jobBrief.employmentType} onChange={event => update('employmentType', event.target.value as JobBrief['employmentType'])}><option value="full_time">全职</option><option value="part_time">兼职</option><option value="contract">合同</option><option value="internship">实习</option></select></div><div><label htmlFor="job-status">岗位状态</label><select id="job-status" value={p.jobBrief.status} onChange={event => update('status', event.target.value as JobBrief['status'])}><option value="draft">草稿</option><option value="open">招聘中</option><option value="paused">已暂停</option><option value="closed">已关闭</option></select></div><div><label htmlFor="job-target">招聘人数</label><input id="job-target" type="number" min={1} max={999} value={p.jobBrief.hiringTarget} onChange={event => update('hiringTarget', Number(event.target.value))} /></div></div>
    <label htmlFor="job-requirements">完整要求</label><textarea id="job-requirements" maxLength={4000} value={p.jobBrief.requirements} placeholder="描述职责、经验和需要特别核实的信息。" onChange={event => update('requirements', event.target.value)} />
    <label htmlFor="job-criteria">逐项判断条件</label><textarea id="job-criteria" value={p.criteriaInput} placeholder={'5 年以上 Java 经验\n熟悉 Spring Boot\n有微服务生产经验'} onChange={event => { p.setCriteriaInput(event.target.value); p.setSaved(false); setPendingSave(null) }} />
    {pendingSave && <div className="change-preview job-change-preview"><WarningCircle size={18} /><div><strong>确认更新岗位条件</strong><p>{pendingSave.role}，{pendingSave.location || '地点未设置'}，{pendingSave.salaryRange || '薪资未设置'}，共 {pendingSave.criteria.length} 项判断条件。</p></div><button className="secondary-button" onClick={() => setPendingSave(null)}>取消</button><button className="primary-button" onClick={() => void p.run(() => persist(pendingSave, false))}>确认保存</button></div>}
    <div className="form-footer"><p>每行一项，最多 12 项。Agent 会分别引用证据，不会把相关线索当成明确满足。</p><button className="primary-button" disabled={p.busy || !p.jobBrief.role.trim() || !p.jobBrief.requirements.trim() || !p.criteriaInput.trim()} onClick={() => { const value = { ...p.jobBrief, criteria: p.criteriaInput.split('\n').map(i => i.trim()).filter(Boolean) }; if (p.isNew) void p.run(() => persist(value, true)); else setPendingSave(value) }}>{p.isNew ? '创建岗位' : '预览修改'}</button></div>
  </section></div></div>
}

type RecordsProps = { assessments: AssessmentCard[]; events: RecruitmentEvent[]; scope: 'active' | 'all'; setScope: (v: 'active' | 'all') => void; setAssessments: (v: AssessmentCard[]) => void; run: (fn: () => Promise<void>) => Promise<void> }
function RecordsPage(p: RecordsProps) {
  const [pendingGreeting, setPendingGreeting] = useState('')
  async function greet(card: AssessmentCard) {
    const visible = await window.agenthr.listVisibleCandidates()
    const normalize = (value: string) => value.replace(/\s+/gu, '')
    const matches = visible.filter(candidate => normalize(candidate.name) === normalize(card.candidateName) && candidate.fingerprint)
    if (matches.length !== 1 || !matches[0].fingerprint) throw new Error('请在 BOSS 推荐页保持该候选人卡片可见，然后重试')
    await window.agenthr.greetBossCandidate({ assessmentId: card.id, fingerprint: matches[0].fingerprint, confirmed: true })
    setPendingGreeting('')
  }
  return <div className="content-scroll narrow records-layout"><section className="surface"><div className="surface-head"><div><span>证据记录</span><h2>候选人分析</h2></div><div className="segmented">{([['active', '当前岗位'], ['all', '全部']] as const).map(([scope, label]) => <button key={scope} className={p.scope === scope ? 'active' : ''} onClick={() => void p.run(async () => { p.setScope(scope); p.setAssessments(await window.agenthr.listAssessments(scope)) })}>{label}</button>)}</div></div>{p.assessments.length === 0 ? <Empty icon={ClockCounterClockwise} title="暂无分析记录" body="让 Agent 读取岗位与简历后，分析会连同证据原文保存在这里。" /> : <div className="assessment-list">{p.assessments.map(card => {
    const eligible = card.platform === 'boss' && card.reviewStatus === 'reviewed' && card.findings.length > 0
      && card.findings.every(finding => finding.verdict === 'explicit_evidence' || finding.verdict === 'related_clue')
    return <article className="assessment" key={card.id}><div className="assessment-head"><div><strong>{card.candidateName || '当前候选人'}</strong><span>{card.role} · {card.platform === 'boss' ? 'BOSS 直聘' : '猎聘'}</span></div><select aria-label="人工复核状态" value={card.reviewStatus} onChange={event => { setPendingGreeting(''); void p.run(async () => { await window.agenthr.setReviewStatus(card.id, event.target.value as AssessmentCard['reviewStatus']); p.setAssessments(await window.agenthr.listAssessments(p.scope)) }) }}><option value="draft">待复核</option><option value="needs_clarification">待确认技能</option><option value="reviewed">已复核</option></select></div>{card.findings.map((finding, index) => <div className="finding" key={`${card.id}-${index}`}><div><strong>{finding.criterion}</strong><span className={`verdict ${finding.verdict}`}>{{ explicit_evidence: '明确证据', related_clue: '相关线索', unknown: '未知', explicit_mismatch: '明确不符' }[finding.verdict]}</span></div>{finding.evidenceQuote && <blockquote>{finding.evidenceQuote}</blockquote>}<p>{finding.reasoning}</p>{finding.questionDraft && <small>待确认：{finding.questionDraft}</small>}</div>)}{card.greeting ? <div className="greeting-action"><div><strong>{card.greeting.result === 'greeted' ? '已在 BOSS 打招呼' : 'BOSS 已在沟通'}</strong><small>{new Date(card.greeting.createdAt).toLocaleString()}，系统不会重复发送。</small></div></div> : eligible && <div className="greeting-action">{pendingGreeting === card.id ? <><div><strong>确认在 BOSS 主动打招呼？</strong><small>使用平台默认招呼语。发送后不可撤回，不会重复联系已沟通候选人。</small></div><button className="secondary-button" onClick={() => setPendingGreeting('')}>取消</button><button className="primary-button" onClick={() => void p.run(() => greet(card))}>确认打招呼</button></> : <><div><strong>符合当前岗位条件</strong><small>已复核且没有未知或明确不符项。</small></div><button className="secondary-button" onClick={() => setPendingGreeting(card.id)}>在 BOSS 打招呼</button></>}</div>}</article>
  })}</div>}</section><section className="surface event-surface"><div className="surface-head"><div><span>审计时间线</span><h2>最近变更</h2></div></div>{p.events.length === 0 ? <Empty icon={ClockCounterClockwise} title="暂无变更事件" body="候选人、任务和分析变更会自动记录。" /> : <div className="event-list">{p.events.slice(0, 30).map(event => <article key={event.id}><span className="event-line" /><div><strong>{event.summary}</strong><p>{new Date(event.createdAt).toLocaleString()}</p></div></article>)}</div>}</section></div>
}
function Empty({ icon: Icon, title, body }: { icon: typeof UsersThree; title: string; body: string }) { return <div className="empty-state"><Icon size={24} weight="duotone" /><h3>{title}</h3><p>{body}</p></div> }
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
