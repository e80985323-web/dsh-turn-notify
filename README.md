# dsh-turn-notify

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D4.svg)
![PowerShell 5.1](https://img.shields.io/badge/PowerShell-5.1-5391FE.svg)
![Node 18+](https://img.shields.io/badge/node-%3E%3D18-339933.svg)
[![GitHub tag](https://img.shields.io/github/v/tag/e80985323-web/dsh-turn-notify)](https://github.com/e80985323-web/dsh-turn-notify/tags)

DSH Desktop 的**右下角通知**插件：agent 每轮回复结束后弹一下。

## 它做什么

两条通道，互不依赖：

| 场景 | 表现 |
| --- | --- |
| 你正看着 DSH 窗口 | 窗口**右下角**滑入一张卡片：`回复完成` + 会话标题 + 回复开头摘要，6 秒自动消失，点一下立即关 |
| 你切走了 / 窗口最小化 | 弹 **Windows 系统通知**（通知中心 toast）；**点它就跳回 DSH Desktop** |
| **模型在等你回答**（提问、要你选一个选项） | 卡片：`等待你的选择` + 问题原文 + 可选项。**不会自动消失**，答完才收 |
| **模型在等你批准**（沙箱升级 / 危险操作） | 卡片：`等待你的批准` + 工具名 + 理由。同样**不会自动消失** |

判定依据是浏览器实时上报的窗口焦点 + 可见性，所以「盯着看」的时候不会被系统通知打扰。

后两行为什么要单独做：`ask_user_question` 和批准确认都是**阻塞**的 —— 它们卡在轮次中间
等你操作，那个轮次直到你答完才结束。所以**整个等待期间 `turn/end` 根本不会触发**，
只监听「回复结束」的实现在这段时间是彻底静默的 —— 而这段时间恰恰最需要提醒：
人已经去干别的了，不提醒就一直干等。0.3.0 起改为在提问/请求批准**发生的那一刻**就提醒。

> **如果页面是在插件安装前加载的**（没刷新过），注入的脚本不存在，两条通道会同时失灵：
> 卡片不出现，焦点也永远上报不了。这时插件会把「从未上报过焦点」当成失焦处理，
> **系统通知照发**（否则就彻底静默了），并在日志里写明原因。刷新页面即恢复两条通道。

## 点通知跳回 DSH Desktop

**点右下角的系统通知，DSH Desktop 窗口会还原并跳到前台**（最小化了也会还原）。

原理：DSH Desktop 是单实例应用（启动第二个实例会把请求转交给已有实例，然后自己退出），
所以「跳回」= 重新拉起 `DSH Desktop.exe`。已有窗口收到转交后 `restore → show → focus`。
实测约 **0.4 秒**生效，且**不会重载页面**（外壳只在 origin 不同时才重载），会话状态不丢。

为什么不直接靠 toast 自己的点击：toast 上的 AUMID 只决定「这条通知算谁发的」，
不决定「点了启动谁」。DSH Desktop 有 AUMID（`io.dsh.desktop`）但**没有注册
ToastActivatorCLSID**（COM 激活器），所以**普通 toast 点下去什么都不会发生** ——
实测：无新进程、窗口不动、前台不变。

因此插件走协议激活：注册一个**用户级** URI scheme，让 toast 用
`activationType="protocol"` 指向它。

- 注册位置：`HKCU:\Software\Classes\dsh-turn-notify`（**当前用户，不需要管理员**）
- 指向：DSH Desktop 的安装位置（自动从开始菜单快捷方式读取；读不到则回退到
  从运行中的进程查 `Path`），所以换台机器装到别处也不用改代码
- 时机：发通知时**自动确保/自愈**，已注册且目标仍存在就只读一次注册表，不重复写

卸载这一项（插件本体不受影响）：

```powershell
Remove-Item HKCU:\Software\Classes\dsh-turn-notify -Recurse -Force
```

关掉跳转、只发普通通知：设置里 `clickToFocus` 改 `false`（此时不会注册任何注册表项）。

窗口内的卡片**也**可点击跳转，但只在**浏览器里打开这个 GUI** 时才有意义：
已经在桌面版里，点卡片再「跳转到桌面版」是句空话，所以此时点击只关掉卡片。
判定用 User-Agent（Electron 外壳带 `Electron`），不用 URL 参数 —— 桌面版确实会往 URL
上挂 `dsh-desktop-mode`，但 harness 的 token 鉴权会 303 跳到不带 query 的裸路径，
参数到不了页面（实测 `location.search` 为空）。

### 为什么做不到「跳到某一条具体会话」

harness 前端**没有**任何按 URL/hash 定位会话的路由（打包产物里搜不到
`searchParams.get(...)` 与 `location.hash` 的读取），所以只能做到「把窗口叫到前台」，
做不到「跳到那条回复」。这是能力边界，不是没做完。

## 安装

这个插件是纯 profile 插件，**不改 DSH Desktop 的任何打包文件**。

```powershell
dsh plugin --profile web add link:C:\Users\<你>\AppData\Roaming\dsh-desktop\harness\local-plugins\dsh-turn-notify
```

或者手工两步：

1. `%APPDATA%\dsh-desktop\harness\profiles\web\package.json` 的 `dependencies` 里加
   `"dsh-turn-notify": "link:C:\\Users\\<你>\\AppData\\Roaming\\dsh-desktop\\harness\\local-plugins\\dsh-turn-notify"`
   （注意 JSON 里反斜杠要写成 `\\`；相对路径 `file:../../local-plugins/dsh-turn-notify` 也可以）
2. 同一个文件的 `dsh.profile.bundles` 数组里加 `"dsh-turn-notify"`
3. 在 `profiles/web` 下 `pnpm install`（或直接重启 DSH Desktop）

装配有两条路径，都已验证一致：改完 profile 清单后**重启**由 `bundles` 正常装配；
运行期则靠 loader 动态加载（本次就是这么装的，免重启生效）。

## 设置

配置文件：`%APPDATA%\dsh-desktop\harness\.dsh-turn-notify.json`（DSH_HOME 下）。
改完**刷新页面**即可生效（脚本与配置都是每次请求现读，不用重启 harness）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `inWindow` | `true` | 窗口内右下角卡片 |
| `osToast` | `true` | 系统通知 |
| `onlyWhenUnfocused` | `true` | 只在窗口失焦/不可见时发系统通知；改 `false` 就是每轮都发 |
| `suppressSubagents` | `true` | 屏蔽子代理（spawn/fork 的子会话）的轮次，只提醒主会话 |
| `suppressCurrentSession` | `true` | 「你正在看的那个会话」的**回复完成**不提醒（看得到的东西不用再弹）。**不影响**下面两类等你动手的通知 |
| `digestWindowMs` | `2500` | 多个会话在这么长时间内先后收尾时合成一条，避免多开时刷屏；`0` = 逐条弹 |
| `notifyOnQuestion` | `true` | **模型在等你回答**（`ask_user_question`）时提醒 |
| `notifyOnApproval` | `true` | **模型在等你批准**（沙箱升级/危险工具）时提醒 |
| `minIntervalMs` | `3000` | 系统通知最小间隔，防止多会话同时收尾刷屏 |
| `durationMs` | `6000` | 卡片自动消失时间（**「等你动手」的两类卡片不受此限**，见下） |
| `maxPreviewChars` | `140` | 摘要最大字符数 |
| `maxCards` | `3` | 右下角最多同时堆几张卡 |
| `onlyWithText` | `false` | 改 `true` 则纯工具轮/报错轮不提醒 |
| `clickToFocus` | `true` | 注册 URI scheme，让**点系统通知跳回 DSH Desktop**；改 `false` 则发普通通知（点击无反应），且不碰注册表 |

### 「等你动手」的两类通知和普通通知不一样

模型提问（`question`）和请求批准（`approval`）是**待办**，不是「刚刚发生了什么」的播报，
所以它们有三条特殊待遇 —— 都为了让「轮到你了」不被漏掉：

1. **不自动消失。** 普通卡片 6 秒后收走；这两类会一直挂着，直到你点掉它、
   或者答完之后收到下一条通知。人去泡杯茶回来，卡片还在。
2. **不受 `suppressCurrentSession` 压制。** 「回复完成」在你正看着的会话里不弹是对的
   （内容就在屏幕上）；但「轮到你了」即使在当前会话里也照弹 ——
   「看得到」不等于「注意到了」，而漏掉它的代价是一直干等。
3. **不受限流、不进聚合。** 被 `minIntervalMs` 吞掉或跟别的会话凑成一条，等于没提醒。

另外，答完之后那张卡片会**按会话**收掉：只有**同一个会话**的后续通知才会收它。
别的会话收尾不会顶掉这个会话的待办 —— 否则你正好在那时看屏幕，就再也看不到它在等你了。
通知里不带会话 id 时（聚合条目）**一张都不收**：不知道是谁的，就别动。

也可以走 HTTP 接口改（会落盘）：

```powershell
# 读
curl http://127.0.0.1:43129/dsh-turn-notify/config.json
# 改（只写要覆盖的键）
curl -X PUT http://127.0.0.1:43129/dsh-turn-notify/config.json `
  -H 'Content-Type: application/json' -d '{"durationMs":10000}'
```

## 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/dsh-turn-notify/last.json` | 最近一轮的通知内容（`seq` 递增，供前端判断「新的一轮」） |
| POST | `/dsh-turn-notify/focus` | 浏览器上报 `{focused, visible}` |
| POST | `/dsh-turn-notify/focus-desktop` | **把 DSH Desktop 窗口叫到前台**（卡片点击走这里；返回真实结果，不是「已受理」） |
| GET/PUT | `/dsh-turn-notify/config.json` | 读写设置 |
| GET | `/dsh-turn-notify/log.json` | 最近 60 行运行日志 |
| POST | `/dsh-turn-notify/test` | **自检**：`{"mode":"os"｜"inWindow"｜"question"｜"both"}` 立刻走一遍真实派发路径（`question` 用来预览「等你回答」那张不自动消失的卡片） |
| GET | `/dsh-turn-notify/notify.js` | 注入到页面的客户端脚本 |

日志文件：`%APPDATA%\dsh-desktop\harness\.dsh-turn-notify.log`

`last.json` 里三个名字相近但含义不同的字段，别混：

| 字段 | 含义 |
| --- | --- |
| `osToastChannel` | **历史上**哪条通道成功过（全局事实） |
| `osToast` / `osToastSkip` | **这一轮**到底发没发、没发是为什么（逐轮事实） |
| `osToastClickable` | 最近一次的系统通知**能不能点击跳回**（逐次事实） |

### 怎么确认它在工作

```powershell
# 1) 系统通知通道通不通（应立刻弹一条「测试通知」）
curl -X POST http://127.0.0.1:43129/dsh-turn-notify/test `
  -H 'Content-Type: application/json' -d '{"mode":"os"}'

# 2) 看结果：via 说明走通了哪条通道
curl http://127.0.0.1:43129/dsh-turn-notify/log.json
```

系统通知失败时是**静默的**（Windows 侧开关、专注助手、AUMID 注册都在系统里，
插件看不到），所以留了这个自检入口，不用靠「怎么没弹」来猜。
自检会绕过 `onlyWhenUnfocused` 和限流 —— 你显式点了就是要现在看到。

## 验证过什么

不是"看起来能跑"，是逐项跑过的：

| 项 | 结果 |
| --- | --- |
| 真实 `turn/end` → 卡片出现 | ✅ 真实会话轮次，`seq` 增长 → DOM 里量到卡片矩形 → 7 秒后自动消失 |
| **真实窗口里出现卡片** | ✅ 直接对**真实 DSH Desktop 窗口**截图（PrintWindow），逐字读到卡片正文，鲸鱼挂件在右下角且不重叠 |
| 系统通知真的弹在屏幕上 | ✅ 截图取证（DPI-aware 全屏 2560×1600），逐字读到标题与正文 |
| 系统通知通道 | ✅ `winrt:io.dsh.desktop`（本机 AUMID 已注册，无需改 DSH 打包文件） |
| **点通知跳回桌面版** | ✅ 窗口最小化 → 点击 → **239ms 还原、248ms 到前台**（A/B 对照见下） |
| **点通知的归因** | ✅ 同样发通知、只差「点 / 不点」：点了 `spawned=true`，不点 `spawned=false` |
| 卡片点击（浏览器里） | ✅ 真实浏览器里点卡片 → 网络层抓到 `POST /focus-desktop` |
| 卡片点击（桌面版内） | ✅ UA 模拟 Electron 外壳：`data-jump=0`，**不发**跳转请求，只关闭 |
| 与鲸鱼挂件共存 | ✅ 卡片底 803 / 挂件顶 811，零重叠 |
| 子代理屏蔽 | ✅ A/B 对照：关掉会提醒，开着不提醒（同一真实子代理会话） |
| 总开关 kill-switch | ✅ `enabled=false` 后经历真实轮次，`seq` 不变 |
| **「等你回答」会提醒** | ✅ **随包发布**：`scripts/host-test.mjs`（事件形状取自真实会话记录，不是编的） |
| **「等你批准」会提醒** | ✅ 同上；含「人正看着这个会话时也照弹」的回归用例 |
| **等待类卡片不自动消失** | ✅ **随包发布**：`scripts/client-test.mjs`，jsdom + 虚拟时钟推进到 7s / 60s 后卡片仍在 |
| **答完只收同一会话的卡片** | ✅ 同上：跨会话不误收、不带 sessionId 时一张都不收 |
| 宿主逻辑回归测试 | ✅ **随包发布**：`scripts/host-test.mjs`，31/31（三种 kind、子代理、开关、畸形事件、跨重载 seq 单调…） |
| PS 脚本守卫 | ✅ **随包发布**：`scripts/ps1-guard.mjs`，10 项检查全过；另有 5 个变异用例证明它**不是空转**（见「开发自检」） |
| 未污染其他插件 | ✅ 鲸鱼挂件/侧边栏/输入框均正常 |

> **关于这张表的读法**：它是作者在本机上逐项实测的记录，不是 CI 结果。
> 其中 **`host-test.mjs` / `client-test.mjs` / `ps1-guard.mjs` 都已随包发布**，
> `npm test` 可直接复跑（`client-test` 需要 `npm i -D jsdom`，没装会打印 SKIP 而不是失败）。
> 但**取证脚本 `auth.mjs` 没有发布** —— 涉及「窗口到前台」「真实截图」那几行是当时的结论，
> 不是你在这个仓库里能直接复跑的东西。
>
> 另外**没有做到的一件事**：`client-test.mjs` 用的是 jsdom，它验证的是
> **DOM 结构与行为**（卡片在不在、带什么属性、什么时候被移除），**不是像素级外观**。
> 卡片长什么样、颜色对不对、和鲸鱼挂件有没有重叠，仍需人在真浏览器里看一眼。
> （作者环境里 headless Chrome 被沙箱挡住了命名管道，跑不起来真实渲染 —— 如实记在这里。）

### 点击跳转的 A/B/C 对照

「点了一下之后窗口在前台」这种指标**单独看没有意义**：这台机器上 DSH 窗口被最小化后
约 8ms 就自己还原了（连不发通知的对照组也一样），所以「还原了」不能归因给点击。
真正能区分的是**有没有新进程**（单实例转交的必经步骤）：

| 组 | 发通知 | 点击 | 新进程 | 窗口到前台 |
| --- | --- | --- | --- | --- |
| 对照 | ✗ | ✗ | `false` | —（自己就还原了，所以这个指标被弃用） |
| 对照 | ✓ | ✗ | **`false`** | `false` |
| 对照（旧写法：普通 toast） | ✓ | ✓ | **`false`** | `false` |
| **本插件（协议激活）** | ✓ | ✓ | **`true`** | **`true`** |

第三行是关键：**普通 toast 点了等于没点**（无新进程、窗口不动）。这也是为什么必须
注册协议 —— 只加 AUMID 是不够的。

排障时踩到并修掉的真坑，记在这里省得后人再踩：

- **`detached: true` 会让子进程 stdout 捕获为空**（Windows/Node）。表现为日志写
  「结果无法解析」而通知其实已经发出去了 —— 看着像失败。已改为不 detached。
- **Windows PowerShell 5.1 按代码页解码脚本文件**：`toast.ps1` 里一个中文注释
  曾让脚本解析失败。现在该文件是纯 ASCII + UTF-8 BOM，宿主代码页怎么变都不受影响。
- **`pwsh` 7 加载不了 WinRT 类型**（`找不到类型 [Windows.UI.Notifications...]`）。
  涉及 toast 的脚本必须用 `powershell.exe`（5.1），不能用 `pwsh`。
- **同一个坑踩了两次，所以现在有自动守卫**：PS 5.1 按代码页解码无 BOM 的 `.ps1`。
  这次是往 `toast.ps1` 里加了**两行中文注释**，多字节序列吞掉了行尾换行，
  下一行 `if ($Diagnose) {...}` 被并进注释 —— 脚本**照样解析通过**，只是静默少执行一条语句。
  后果：toast 不再带 `activationType="protocol"`，**点击跳转悄悄失效**，
  而其他所有检查（发得出去、能看见、窗口健康）全都是绿的。
  所以这个坑现在有自动守卫：`scripts/ps1-guard.mjs`（**随包发布**，`npm test`）。
  它查 BOM 在不在、正文是否纯 ASCII、真实 PS 5.1 解析器是否报错，并且**回读
  toast 真正据以构建的那段 XML**，断言它确实带 `activationType="protocol"` ——
  让「代码以为设了」和「toast 真的带了」不可能再悄悄分家。
  默认走 `-XmlOnly`（只回 XML、不弹通知，可反复跑），`--live` 才用 `-Diagnose` 真发一条；
  `--selftest` 用 4 个变异副本证明守卫**不是空转** —— 一个永远通过的守卫比没有守卫更糟。
  写完这份 README 之后它立刻就派上用场了：**一次普通编辑把 `toast.ps1` 的 BOM 弄丢了，
  守卫当场报 FAIL**（见「开发自检」）。
- **用 URL 参数判断「是否在桌面版里」不可行**：harness 的 token 鉴权会 303 跳到不带
  query 的裸路径，`dsh-desktop-mode` 到不了页面。改用 User-Agent。
- **「点完在前台」这类指标要先跑对照组**：本机上窗口会自己还原，该指标在对照组里
  也为真，等于什么都没证明。
- **harness 的启动 token 是一次性的**：`dsh web: http://127.0.0.1:43129/?token=XXX`
  里的 token 用一次就作废，第二次拿它访问只会得到 401。踩到的表现极具误导性：
  取证脚本第一次跑通，之后每次都拿到**未登录页面** —— 页面上既没有注入脚本、
  也没有鲸鱼挂件，看起来就像「插件坏了」，其实只是鉴权没过去。
  正确做法：用 token 换**签名 cookie**（有效期约一个月），之后复用 cookie。
  当时的取证脚本统一走 `auth.mjs`（每次从 `logs\harness.log` 取**最新** token 去换
  cookie）。同理，`%LOCALAPPDATA%\Temp\dsh-token.txt` 里存的可能是**旧** token，
  别把它当权威来源 —— 这个文件正是把上一条坑伪装成「插件故障」的原因。

## 开发自检：PS 脚本守卫

```powershell
npm test                            # 检查 lib/*.ps1 + 证明守卫本身有牙齿（5 个变异用例）
npm run guard                       # 只检查 lib/*.ps1
node scripts/ps1-guard.mjs --live   # 额外用 -Diagnose 真发一条 toast
node scripts/ps1-guard.mjs <目录>    # 换个目录检查（变异测试就是这么跑自己的）
```

10 项检查，逐条对应一个**真踩过的坑**，不是通用 lint：

| 检查 | 为什么 |
| --- | --- |
| BOM 在不在 | PS 5.1 对无 BOM 的 `.ps1` 按系统代码页解码 —— 就是那个静默失效的根因 |
| 正文是否纯 ASCII | 只有多字节字符才会触发上一条；纯 ASCII 则任何代码页解出来都一样 |
| 行尾（仅报告） | PS 5.1 两种都认，所以只报不判，不制造假警报 |
| 真实 PS 5.1 解析器 | 拦住语法级破坏（`pwsh` 7 加载不了 WinRT，所以这里必须用 `powershell.exe`） |
| 回读 toast XML 必须带 protocol 激活 | 直接盯历史 bug 的**后果**，而不是盯「代码里有没有写那行」 |
| 宿主必须用 `powershell.exe` | `pwsh` 7 加载不了 `[Windows.UI.Notifications.*]`，toast 会整个失败 |

守卫会认环境：机器上没装 DSH Desktop（协议注册不上）或没有 WinRT 时，对应检查报
`SKIP` 并说明原因，**不会**把「这台机器测不了」谎报成「代码坏了」。

`--selftest` 是给守卫自己做的变异测试：把 `toast.ps1` 故意改坏 4 种方式
（去 BOM / 加中文注释 / 破坏语法 / 删掉协议激活两行），断言守卫**必须**失败；
另加一个未改动副本作**对照**（对照必须通过，否则说明测试台本身是错的，其余结果不作数）。

## 系统通知走的是哪条路

DSH Desktop 的 Electron 主进程只放行 `clipboard-sanitized-write` 权限，**页面里的 Web
Notification API 被硬拒**，所以系统通知必须由宿主进程发起：

`lib/toast.ps1` 按序尝试
1. WinRT `ToastNotificationManager`（真正的通知中心 toast；AUMID 依次试
   `io.dsh.desktop`、`DSH Desktop`、`com.dsh.desktop`、Windows PowerShell 的 AUMID）
   ——用哪个能成会写进日志
2. `System.Windows.Forms.NotifyIcon` 托盘气泡（降级）

`io.dsh.desktop` 排第一是因为本机开始菜单快捷方式带的就是这个 AUMID，
用它发出来的通知在系统里就署名 DSH Desktop（名字和图标都对）。

两条都不成的话，只降级成「只有窗口内卡片」，功能不会整个失效。
回复正文一律走临时 JSON 文件传给 PowerShell，不做 shell 字符串拼接，
`&`、引号、换行、emoji 都不会出问题。

## 卸载

1. `dsh plugin --profile web remove dsh-turn-notify`，或手工删掉上面那两行 + `pnpm install`
2. 想彻底清干净再删目录 `%APPDATA%\dsh-desktop\harness\.dsh-turn-notify.json` /
   `.dsh-turn-notify.log`
3. 若开过 `clickToFocus`，删掉它注册的协议项：
   `Remove-Item HKCU:\Software\Classes\dsh-turn-notify -Recurse -Force`

本插件不改动 DSH Desktop 的任何打包文件。

## 与 dsh-whale-widget 共存

鲸鱼挂件也锚在右下角，所以卡片渲染前会实测它的 `getBoundingClientRect()`，
把卡片堆到它上方；没有挂件或挂件不在右下角时贴边 16px。
