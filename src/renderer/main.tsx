import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'

type BossPage = 'login' | 'recommend' | 'messages'
type Platform = 'boss' | 'liepin'

const pages: { id: BossPage; label: string }[] = [
  { id: 'login', label: '登录' },
  { id: 'recommend', label: '候选人' },
  { id: 'messages', label: '沟通' },
]

function App() {
  const [status, setStatus] = useState<AgentHrStatus>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [candidates, setCandidates] = useState<CandidatePreview[]>([])
  const [resume, setResume] = useState<OpenResume | null>(null)
  const [jobBrief, setJobBrief] = useState<JobBrief>({ role: '', requirements: '', criteria: [] })
  const [criteriaInput, setCriteriaInput] = useState('')
  const [jobBriefSaved, setJobBriefSaved] = useState(false)
  const [jobList, setJobList] = useState<JobList>({ activeId: null, jobs: [] })
  const [newJob, setNewJob] = useState(true)
  const [assessments, setAssessments] = useState<AssessmentCard[]>([])
  const [assessmentScope, setAssessmentScope] = useState<'active' | 'all'>('active')
  const [workspaceTab, setWorkspaceTab] = useState<'chat' | 'workspace'>('chat')

  function applyJobList(value: JobList) {
    setJobList(value)
    const active = value.jobs.find(job => job.id === value.activeId)
    if (active) {
      setJobBrief({ role: active.role, requirements: active.requirements, criteria: active.criteria })
      setCriteriaInput(active.criteria.join('\n'))
      setJobBriefSaved(true)
      setNewJob(false)
    }
  }

  useEffect(() => {
    void window.agenthr.getStatus().then(setStatus).catch(e => setError(String(e)))
    void window.agenthr.listJobs().then(applyJobList).catch(e => setError(String(e)))
    void window.agenthr.listAssessments('active').then(setAssessments).catch(e => setError(String(e)))
    const stopStatus = window.agenthr.onStatus(setStatus)
    const stopJobs = window.agenthr.onJobsChanged(() => {
      void window.agenthr.listJobs().then(applyJobList).catch(e => setError(String(e)))
    })
    return () => { stopStatus(); stopJobs() }
  }, [])

  useEffect(() => {
    setCandidates([])
    setResume(null)
  }, [status.browser?.platform, status.browser?.url, status.browser?.loading])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  async function switchWorkspaceTab(tab: 'chat' | 'workspace') {
    await window.agenthr.setWorkspaceTab(tab)
    setWorkspaceTab(tab)
    if (tab === 'workspace') {
      applyJobList(await window.agenthr.listJobs())
      setAssessments(await window.agenthr.listAssessments(assessmentScope))
    }
  }

  async function fillQuickPrompt(prompt: string) {
    await switchWorkspaceTab('chat')
    await window.agenthr.insertDshPrompt(prompt)
  }

  const dshPhase = status.dsh?.phase ?? 'unconfigured'
  const platform = status.browser?.platform ?? 'liepin'
  const dshLabel: Record<NonNullable<AgentHrStatus['dsh']>['phase'], string> = {
    unconfigured: '未配置', starting: '启动中', ready: '已连接', stopped: '已停止', failed: '启动失败',
  }

  return <div className="app">
    <header className="topbar">
      <div className="brand"><span className="brandmark">A</span><span>AgentHR</span><small>招聘工作台 · 技术预览</small></div>
      <div className="top-actions">
        {error && <span className="top-error" title={error}>{error}</span>}
        <span className={`runtime ${dshPhase}`}>DSH {dshLabel[dshPhase]}</span>
        {(dshPhase === 'failed' || dshPhase === 'stopped' || dshPhase === 'unconfigured')
          && <button className="dsh-button secondary" disabled={busy} onClick={() => void run(() => window.agenthr.restartDsh())}>重试 Agent</button>}
        <button className="dsh-button" disabled={dshPhase !== 'ready'} onClick={() => void run(() => window.agenthr.openDsh())}>弹出对话 ↗</button>
      </div>
    </header>
    <aside className={`panel ${workspaceTab === 'chat' ? 'chat-mode' : ''}`}>
      <div className="workspace-tabs">
        <button className={workspaceTab === 'chat' ? 'selected' : ''} disabled={busy} onClick={() => void run(() => switchWorkspaceTab('chat'))}>AI 对话</button>
        <button className={workspaceTab === 'workspace' ? 'selected' : ''} disabled={busy} onClick={() => void run(() => switchWorkspaceTab('workspace'))}>岗位与记录</button>
      </div>
      {workspaceTab === 'chat' && <div className="quick-actions">
        <button disabled={busy || dshPhase !== 'ready'} onClick={() => void run(() => fillQuickPrompt('请先识别当前招聘页面，读取可见候选人卡片，并告诉我下一步适合查看谁；不要发送消息。'))}>识别当前页</button>
        <button disabled={busy || dshPhase !== 'ready'} onClick={() => void run(() => fillQuickPrompt('请根据我接下来描述的招聘需求，整理岗位名称、完整要求和逐项技能条件，并保存为当前岗位。岗位需求：'))}>描述岗位</button>
        <button disabled={busy || dshPhase !== 'ready'} onClick={() => void run(() => fillQuickPrompt('请读取当前岗位和已打开的简历，逐项判断技能证据，引用原文，生成需要确认的技能问题草稿，并保存分析卡片。不要询问薪资或求职意向，不要发送消息。'))}>分析简历</button>
      </div>}
      {workspaceTab === 'chat' && <div className="chat-placeholder">
        <span className="eyebrow">AGENT / CONVERSATION</span>
        <h2>{dshPhase === 'ready' ? '正在打开 Agent 对话…' : '等待 DSH 对话就绪'}</h2>
        <p>你可以直接描述岗位或让 Agent 查看当前页面。右侧对话框就绪后，常用按钮会把提示词填入输入框，仍可自行修改。</p>
      </div>}
      <div className="workspace-content">
      <div className="eyebrow">工作空间 / 01</div>
      <h1>从候选人线索<br />走向有依据的推荐</h1>
      <p className="intro">可在 AI 对话中描述岗位、识别左侧招聘页面并打开候选人详情。Agent 可读取当前资料并生成有依据的分析草稿；招聘网站兼容性仍需你在实际页面验证。</p>

      <section className="section">
        <div className="section-head"><h2>当前岗位条件</h2><span className="badge">本机保存</span></div>
        <div className="job-selector"><select aria-label="选择岗位" disabled={busy || jobList.jobs.length === 0} value={newJob ? '' : jobList.activeId ?? ''} onChange={event => void run(async () => {
          const record = await window.agenthr.activateJob(event.target.value)
          setJobBrief({ role: record.role, requirements: record.requirements, criteria: record.criteria })
          setCriteriaInput(record.criteria.join('\n'))
          setJobList(await window.agenthr.listJobs())
          setNewJob(false)
          setJobBriefSaved(true)
          setAssessments(await window.agenthr.listAssessments(assessmentScope))
        })}><option value="">{newJob ? '新岗位（未保存）' : '选择已保存岗位'}</option>{jobList.jobs.map(job => <option key={job.id} value={job.id}>{job.role}</option>)}</select>
          <button disabled={busy} onClick={() => void run(async () => {
            await window.agenthr.clearActiveJob()
            setJobList(await window.agenthr.listJobs())
            setJobBrief({ role: '', requirements: '', criteria: [] })
            setCriteriaInput('')
            setNewJob(true)
            setJobBriefSaved(false)
            setAssessments(await window.agenthr.listAssessments(assessmentScope))
          })}>＋ 新建</button>
        </div>
        <label className="field-label" htmlFor="job-role">岗位名称</label>
        <input id="job-role" className="job-input" maxLength={120} value={jobBrief.role} placeholder="例如：动物造模研发" onChange={event => { setJobBrief({ ...jobBrief, role: event.target.value }); setJobBriefSaved(false) }} />
        <label className="field-label" htmlFor="job-requirements">技能与经历要求</label>
        <textarea id="job-requirements" className="job-input job-textarea" maxLength={4000} value={jobBrief.requirements} placeholder="例如：需要熟悉 tMCAO 动物造模；泛称动物实验或 MCAO 只算相关线索，需确认亲自操作的环节与独立程度。" onChange={event => { setJobBrief({ ...jobBrief, requirements: event.target.value }); setJobBriefSaved(false) }} />
        <label className="field-label" htmlFor="job-criteria">逐项分析的技能条件（每行一项，最多 12 项）</label>
        <textarea id="job-criteria" className="job-input job-textarea" value={criteriaInput} placeholder={'熟悉 tMCAO 动物造模\n具备 CNS 方向研发经验'} onChange={event => { setCriteriaInput(event.target.value); setJobBriefSaved(false) }} />
        <button className="read-button" disabled={busy || !jobBrief.role.trim() || !jobBrief.requirements.trim() || !criteriaInput.trim()} onClick={() => void run(async () => {
          const value = { ...jobBrief, criteria: criteriaInput.split('\n').map(item => item.trim()).filter(Boolean) }
          const record = newJob ? await window.agenthr.createJob(value) : await window.agenthr.saveJobBrief(value)
          setJobBrief({ role: record.role, requirements: record.requirements, criteria: record.criteria })
          setCriteriaInput(record.criteria.join('\n'))
          setJobList(await window.agenthr.listJobs())
          setNewJob(false)
          setJobBriefSaved(true)
          setAssessments(await window.agenthr.listAssessments(assessmentScope))
        })}>{newJob ? '创建并启用岗位' : '保存当前岗位条件'}</button>
        <p className="hint">{jobBriefSaved ? '已保存，Agent 可读取当前岗位条件。' : '保存后 Agent 才能按此岗位判断；这里不填写薪资和求职意向。'}</p>
      </section>

      <section className="section">
        <div className="section-head"><h2>招聘网站</h2><span className={`dot ${status.browser?.loading ? 'active' : ''}`} /></div>
        <div className="platforms">{([['liepin', '猎聘企业端'], ['boss', 'BOSS 直聘']] as [Platform, string][]).map(([id, label]) => <button key={id} className={platform === id ? 'selected' : ''} disabled={busy} onClick={() => void run(async () => { setCandidates([]); setResume(null); await window.agenthr.selectPlatform(id) })}>{label}</button>)}</div>
        <div className="tabs">{pages.map(page => <button key={page.id} disabled={busy || (platform === 'liepin' && page.id === 'messages')} title={platform === 'liepin' && page.id === 'messages' ? '猎聘独立消息页尚未验证' : undefined} onClick={() => void run(async () => { setCandidates([]); setResume(null); await window.agenthr.openPage(page.id) })}>{page.label}</button>)}</div>
        <button className="reload" disabled={busy} onClick={() => void run(async () => { setCandidates([]); setResume(null); await window.agenthr.reloadPage() })}>↻ 刷新当前页面</button>
        <div className="site-status">
          <span>当前页面</span>
          <strong>{status.browser?.title || '等待加载'}</strong>
          <code>{status.browser?.url || '—'}</code>
        </div>
        {status.browser?.error && <p className="alert">{status.browser.error}</p>}
      </section>

      <section className="section">
        <div className="section-head"><h2>当前页候选人</h2><span className="badge">只读</span></div>
        <button className="read-button" disabled={busy} onClick={() => void run(async () => setCandidates(await window.agenthr.listVisibleCandidates()))}>读取{platform === 'boss' ? 'BOSS' : '猎聘'}当前页卡片</button>
        {candidates.length > 0 && <div className="candidate-list">{candidates.map(candidate => <article className="candidate" key={candidate.cardIndex}>
          <strong>{candidate.name || `候选人 ${candidate.cardIndex + 1}`}</strong>
          {candidate.skills && <p>{candidate.skills}</p>}
          {candidate.summary && <p>{candidate.summary}</p>}
        </article>)}</div>}
        <button className="read-button secondary" disabled={busy} onClick={() => void run(async () => { setResume(null); setResume(await window.agenthr.readOpenResume()) })}>读取已打开的简历详情</button>
        <p className="hint">请先在左侧打开一份简历，或让 Agent 从当前卡片进入详情。这里显示读取时的快照，切换候选人后请重新读取。</p>
        {resume && <div className="resume-detail"><strong>{resume.name || '当前简历'}</strong><pre>{resume.text}</pre></div>}
      </section>

      <section className="section workflow">
        <div className="section-head"><h2>分析队列</h2><span className="badge">人工复核</span></div>
        <div className="assessment-filters">
          {([['active', '当前岗位'], ['all', '全部记录']] as const).map(([scope, label]) => <button key={scope} className={assessmentScope === scope ? 'selected' : ''} disabled={busy} onClick={() => void run(async () => {
            setAssessmentScope(scope)
            setAssessments(await window.agenthr.listAssessments(scope))
          })}>{label}</button>)}
        </div>
        <button className="read-button secondary" disabled={busy} onClick={() => void run(async () => setAssessments(await window.agenthr.listAssessments(assessmentScope)))}>刷新分析卡片</button>
        <p className="hint">当前岗位只显示与已保存岗位条件完全对应的分析；修改条件前的记录可在“全部记录”查看。相同简历和岗位的完全相同分析不会重复入队。人工状态只记录卡片复核，不代表技能已确认或已联系候选人。</p>
        {assessments.length === 0 && <p className="hint">暂无分析记录。由 Agent 读取当前岗位和已打开简历后，可保存带原文依据的草稿。</p>}
        <div className="assessment-list">{assessments.map(card => <article className="assessment" key={card.id}>
          <div className="assessment-title"><strong>{card.candidateName || '当前候选人'}</strong><span>{card.platform === 'boss' ? 'BOSS 直聘' : '猎聘'} · {card.role}</span></div>
          <div className="assessment-review"><label htmlFor={`review-${card.id}`}>人工状态</label><select id={`review-${card.id}`} value={card.reviewStatus} disabled={busy} onChange={event => void run(async () => {
            await window.agenthr.setReviewStatus(card.id, event.target.value as AssessmentCard['reviewStatus'])
            setAssessments(await window.agenthr.listAssessments(assessmentScope))
          })}><option value="draft">待复核</option><option value="needs_clarification">待技能确认（未联系）</option><option value="reviewed">已复核卡片</option></select></div>
          {card.findings.map((finding, index) => <div className="assessment-finding" key={`${card.id}-${index}`}>
            <p className="assessment-criterion">{finding.criterion}</p>
            <p className="assessment-verdict">{{ explicit_evidence: '明确证据', related_clue: '相关线索', unknown: '未知', explicit_mismatch: '明确不符' }[finding.verdict]}</p>
            {finding.evidenceQuote && <blockquote>{finding.evidenceQuote}</blockquote>}
            <p>{finding.reasoning}</p>
            {finding.questionDraft && <p className="question-draft">技能确认问题草稿：{finding.questionDraft}</p>}
          </div>)}
          <small>分析创建：{new Date(card.createdAt).toLocaleString()}{card.reviewUpdatedAt ? ` · 状态更新：${new Date(card.reviewUpdatedAt).toLocaleString()}` : ''}</small>
        </article>)}</div>
      </section>

      <section className="section workflow">
        <div className="section-head"><h2>第一版流程</h2><span className="badge">推进中</span></div>
        <ol><li>检索并读取候选人</li><li>判断 tMCAO / MCAO 证据</li><li>生成技能确认问题草稿</li><li>形成可追溯分析卡片</li></ol>
      </section>

      <div className="footer-note">浏览器会话独立保存在本机。第一版不自动发送消息，也不追问薪资或求职意向。</div>
      {status.dsh?.detail && <p className="runtime-detail">DSH：{status.dsh.detail}</p>}
      {error && <p className="alert">{error}</p>}
      </div>
    </aside>
    <main className="browser-label"><span>招聘网站浏览区</span><span>内嵌 Chromium · 独立会话</span></main>
  </div>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
