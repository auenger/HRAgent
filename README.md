# AgentHR

独立 Electron 招聘工作台。当前为桌面原型：内嵌 BOSS 直聘与猎聘企业端页面，按平台隔离并持久化浏览器会话；启动本地 DeepSeek Harness（DSH）Host，并通过受控的本机桥接向 DSH 插件提供只读浏览器状态、当前推荐页候选人卡片和已由招聘人员打开的简历详情。两站适配器都尚未经真实招聘页面验证。

产品方向、架构和阶段验收见 [技术栈与实现方案.md](./技术栈与实现方案.md)。

## 本地启动

需要 Node.js `^22.19.0` 或 `>=24`、pnpm 11。项目固定依赖 DSH `0.1.5-rc.2`（2026-09-14 核对的最新发布候选版本，npm `next` 标签）。同级 `/Users/ryan/mycode/dsh` 已快进到远端 `master` 的 `c291e7961a`，其项目版本同为 `0.1.5-rc.2`；AgentHR 运行时使用已发布的 npm 包，不依赖该源码目录。默认用 Electron 自带的 Node 模式启动 DSH：

```sh
pnpm install
pnpm dev
```

仅在开发时需要切换 DSH 或 Node 版本，才设置 `AGENTHR_DSH_CLI`、`AGENTHR_NODE_BIN`。见 [.env.example](./.env.example)；应用不会自动读取 `.env`。依赖安装采用 pnpm 的 hoisted 布局，以便 Electron Builder 收集 DSH 的运行时依赖。

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm package:dir
pnpm verify:package
pnpm smoke:host
pnpm smoke:host:restart
pnpm smoke:host:package
pnpm smoke:agent-tools
pnpm smoke:gui:package
```

## 当前实现

- `src/main/recruitment-browser.ts`：Electron `WebContentsView`，按站点隔离 `persist:` Session，限制主页面导航和弹窗；登录凭据由招聘网站页面及其 Session 管理，不写入 AgentHR 项目文件。
- `src/main/platforms.ts`：站点地址和允许的域名。BOSS 推荐页与猎聘登录/推荐页地址参考 GoodHR 的平台配置；猎聘独立沟通页尚未确认，因此没有臆造 URL。
- `src/main/dsh-host.ts`、`src/main/dsh-profile.ts`：优先使用项目固定的 DSH 版本，通过受管的 Electron Node 子进程启动 DSH Web Host；启动时写入仅含招聘分析人格的 AgentHR preset，并通过 `--patch` 禁用 DSH 随附及用户自定义 preset、加载 AgentHR 插件。Host 从 DSH 的启动输出提取带认证 token 的 Web 入口地址。失败或停止后，工作台可重试 Host；重启会先等待旧子进程退出，应用退出也会有序关闭 Host。显式 CLI/Node 路径仍可作开发覆盖。
- `src/main/adapters/liepin.ts`：参考 goodhr5 的猎聘选择器，读取当前推荐页至多 30 张候选人卡片；只在招聘人员手动打开恰好一份简历弹窗后读取弹窗内容。仅用模拟 DOM 验证，真实页面选择器由用户自行测试。
- `src/main/adapters/boss.ts`：参考 goodhr5 的 BOSS 推荐页 `recommendFrame`、卡片和内层简历 iframe 结构，只读当前卡片及招聘人员已打开的唯一可见简历。仅用模拟 DOM 验证；实际 iframe 层级、选择器和简历完整度由用户自行测试。
- `src/main/job-brief.ts`：招聘人员可创建、切换、编辑本机岗位条件，并为每个岗位列出最多 12 项逐项分析的技能条件；旧版单岗位 JSON 在首次读取时迁移为岗位列表，旧版长段要求保留原文并配一个可编辑的过渡条件。新建岗位尚未保存时没有当前岗位，Agent 不能按上一岗位继续分析。简历正文不会写入岗位配置文件。
- `src/main/bridge.ts`：仅监听 `127.0.0.1` 的随机端口，要求启动时生成的 Bearer Token；提供脱敏页面状态、按需读取的候选人卡片、带 `sourceDigest` 的当前简历详情和带 `jobBriefDigest` 的岗位条件，并允许提交受约束的分析草稿。不开放任意页面脚本执行。
- `src/main/assessments.ts`：使用 Electron 内置 Node 的 `node:sqlite` 保存待人工复核的分析卡片。每项技能条件对应独立的证据分类、原文、理由和问题草稿；提交时重新读取当前简历和岗位条件，核对两者的内容指纹、条件覆盖情况及简历证据原文。保存当前来源平台，完全相同的简历、岗位和分析内容仅在同一平台内去重；招聘人员可记录待复核、待技能确认或已复核状态，按当前岗位条件快照筛选。旧版单结论卡片仍可读取。不把完整简历正文写进分析库。该 SQLite API 在当前 Node 版本仍标为实验性。
- `src/plugin/index.ts`：注册 DSH 工具 `agenthr_get_job_brief`、`agenthr_browser_status`、`agenthr_list_visible_candidates`、`agenthr_read_open_resume`、`agenthr_save_assessment_draft`。AgentHR 专用 preset 包含“明确证据/相关线索/未知/不符”、证据原文和技能问题草稿规则；插件也为其他 DSH preset 注册相同的提示词段落。不存在消息发送工具。
- `src/renderer`：岗位条件编辑、招聘网站切换、两站当前页只读卡片和手动打开的简历读取、按当前岗位或全部记录查看的分析队列及人工状态、DSH 状态与 Agent 窗口；配色参照用户提供的 `tesla_style_fronted` 项目（红 `#E82127`、黑 `#181B21`、深色顶栏、灰白内容区）。

DSH `0.1.5-rc.2` 的部分间接依赖仍会被包管理器解析到旧版；`pnpm-workspace.yaml` 将已发现的 19 个包统一锁到同一版本。当前目录包关闭 ASAR：DSH 会在本机 profile 下建立依赖链接，链接到 ASAR 内文件时，普通 Node 模块解析无法找到这些包。以后若恢复 ASAR，需要参考 DSH Desktop 的包内模块解析和按需解包方案，并重新通过包内 Host 检查。

## 尚未完成的关键工作

1. 由招聘人员在 **Electron 内**自行验证猎聘或 BOSS 登录、重启后的会话和候选人页面。开发阶段不代替用户操作真实招聘账号，也不直接测试真实候选人沟通。
2. 基于用户反馈校正猎聘与 BOSS 的候选人卡片、简历详情和 iframe 选择器，继续实现按平台分离的完整简历字段适配器。当前提取结果是有上限的可见文本，不等于已验证的完整简历结构。第一版不实现消息发送。GoodHR 的对应实现仅作为参考，不把其 Go/CloakBrowser 执行器引入运行时。
3. 将分析队列扩展为具备稳定候选人关联的队列和可编辑证据的人工复核流程；目前只按简历内容指纹与岗位条件快照保存记录，没有稳定的站点候选人 ID。同名或简历更新都不能自动认定为同一人。人工状态只表示卡片处理进度，不表示技能已确认或已联系候选人。Agent 决策与页面动作保持分离。第一版不追问薪资或求职意向。
4. 继续验证正式发行链路。当前 macOS 未签名目录包已包含 DSH CLI 和 AgentHR 插件；`verify:package` 检查包内依赖、插件导入、配置合成及 Electron 内置 SQLite，`smoke:host:package` 已从包内 Electron Node 启动 Host 并取得认证后的本地 Agent 页面。`smoke:gui:package` 在隔离的离线模式下验证了 App 主窗口、React 工作台和 preload 桥接。尚未验证 Windows 包、真实网站登录流程、签名和更新机制，因此不能视为正式发行包。

`smoke:host:restart` 已在隔离目录启动真实 DSH Host、完成两次认证页面访问，并验证 Host 有序重启。Host 重试只恢复 DSH 服务和 Agent 窗口入口；正在运行的 Agent 任务会中断。DSH 会话内容能否在真实招聘操作中按预期恢复，仍需招聘人员在实际使用流程里验证。

第一版的站内搜索和筛选目前由招聘人员在网站页面操作；Agent 只读取当前可见卡片与已经手动打开的简历。GoodHR5 提供了 BOSS 岗位切换输入框的参考配置，但没有可直接复用的跨站候选人检索动作。站内检索自动化应在两站真实页面结构由用户验证后再接入。

## 招聘人员手动验证

1. 在 App 内登录所需平台，打开“候选人”页；重启 App 后检查是否保持登录状态。
2. 使用网站自身的搜索或筛选，点击工作台“读取当前页卡片”，核对只显示当前页候选人及其简要信息。
3. 手动打开一份简历，点击“读取已打开的简历详情”，核对姓名和正文；关闭详情后再次读取应提示没有可读取的简历。切换候选人后须重新读取，工作台显示的是读取时快照。
4. 配置并保存岗位条件，在 Agent 窗口要求按当前简历生成逐项证据与技能确认问题草稿，再检查分析队列中的来源平台、原文证据和“未知”判断。第一版没有发送消息工具。

如页面结构不匹配，记录平台、页面入口、失败步骤和工作台错误文案即可；不要将账号密码或候选人完整简历贴进项目 issue 或日志。

招聘账号和密码不要放进源码、`.env`、测试快照或日志。当前原型不会自动发送候选人消息。

本地检查只使用模拟 DOM、桥接层模拟请求、模拟分析数据、插件工具到桥接和分析库的完整模拟链路、类型检查、构建，以及隔离临时目录里的 DSH Host 和 App GUI。`test` 还会创建真实 DSH Agent 会话并检查工具目录：AgentHR preset 只能看到 5 个招聘工具，没有 Shell、文件或 Web 工具。未登录或操作真实招聘账号。猎聘选择器及 DSH 工具的实际页面运行效果需要由用户在 App 中验证。DSH 会话本身可能记录 Agent 读到的简历内容；当前“不保存完整简历正文”仅指 AgentHR 的分析 SQLite 库。
