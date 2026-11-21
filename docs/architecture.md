# 实时 Excel 数据大屏 · 完整软件设计方案

版本：v1.4 · 2026-11-14
对应实现：`live-sheet-dashboard@1.4.0`（Node.js 22 · 单机单进程 · 浏览器 UI · P1 低代码画布 + AI 适配层 + NOVA UI 已实现）

---

## 0. 一页速览

| 维度 | 方案选择 |
|---|---|
| 产品形态 | 本地 Node 服务 + 浏览器 UI，后续可用 Electron 复用同一服务 |
| 架构风格 | 组合根装配的分层架构；数据摄入、快照存储、通知、交付明确分离 |
| 实时机制 | chokidar 监听文件目录 → 解析 worker → 原子快照 → SSE 通知 → 前端按版本拉取 |
| 解析执行 | 独立 `worker_threads`，带内存、时间、文件、行列和单元格上限 |
| 数据传输 | 大屏取 Document 组件投影；保留旧版兼容字段，原始行数据走分页接口 |
| 一致性 | `version`（数据版本）+ `revision`（状态版本）+ `instanceId`（进程实例） |
| 安全边界 | 默认仅监听 `127.0.0.1`；非回环必须口令 + Host 白名单；本地写接口有 CSRF 防护 |
| 可观测性 | `/api/health`、`/api/ready`、`/api/diagnostics`、结构化本地日志、本地指标 |
| 质量保障 | 24 个自动化测试覆盖解析、调度、安全、API、SSE、分页、会话、Document、Patch 与投影 |

---

## 1. 背景与目标

### 1.1 业务目标

1. Excel 保存后，大屏在无需刷新页面的情况下自动更新。
2. 大屏默认给出可解释的 KPI、趋势、结构和明细预览。
3. 数据异常和表结构问题不导致白屏，保留最后一次成功快照。
4. 系统可单机离线运行，不依赖数据库、云服务或外部模型。

### 1.2 非目标（当前版本不做）

1. 不实现多人在线协同编辑。
2. 不保存历史版本数据库；当前只保留最后一次成功快照。
3. 不内置 AI 调用；AI 相关设计见第 16 节演进方案。
4. 不支持任意客户端路径读取；目标文件只能由服务端配置指定。
5. 不做公网部署；默认安全模型是本机或可信局域网。

### 1.3 核心用户故事

| 用户 | 需求 | 系统响应 |
|---|---|---|
| 数据维护者 | 在 Excel 改数并保存 | 文件事件合并后重解析，SSE 通知，前端自动重绘 |
| 大屏观看者 | 打开大屏即看到当前数据 | 首屏加载投影，连接 SSE，断线自动补齐 |
| 演示者 | 改一个数验证实时性 | 开发模式提供“模拟一次变更”按钮 |
| 运维/开发者 | 判断服务是否健康 | 健康与就绪接口暴露数据、解析、SSE、指标 |
| 安全管理者 | 局域网使用 | 必须配置访问口令和 Host 白名单 |

---

## 2. 质量属性目标与实测

| 属性 | 设计预算 | 当前实测 |
|---|---|---|
| 解析延迟 | 1 万行 ≤ 1s | 1 万行解析 411ms，worker 往返 549ms |
| 小表响应 | 120 行 ≤ 100ms | 约 20ms |
| 端到端感知 | 保存 → 重绘 ≤ 1s | 事件合并 220ms + 解析 + 前端单次拉取 |
| 可用性 | 一次坏保存不清空旧图 | 解析失败保留上一版快照 |
| 并发正确性 | 连续保存只提交最后一次 | single-flight 调度测试通过 |
| 断线恢复 | 重连后不留在旧版本 | `ready` 事件触发版本对齐 |
| 服务重启恢复 | 浏览器识别新进程 | `instanceId` 变化强制重渲染 |
| 安全 | 高风险依赖为 0 | `npm audit`：0 漏洞 |
| 测试 | 关键路径自动化 | 16/16 通过 |

---

## 3. 总体架构

```
Excel / xlsx 文件
   │ 文件保存、创建、删除
   ▼
chokidar watcher ── 目录监听 + awaitWriteFinish
   │ 文件事件（220ms 合并）
   ▼
IngestService
   │ single-flight · generation · retry · stale result 丢弃
   ▼
WorkbookWorker（worker_threads）
   │ SheetJS CE 0.20.3 · 资源上限 · 类型推断 · 体检
   ▼
SnapshotRepository
   │ 原子替换 · version/revision/instanceId · 保留投影
   ▼
SseNotifier ───────────────► 浏览器 EventSource
   │ 只推版本与状态               │
   ▼                              ▼
HTTP Delivery ───────────► /api/projection
   │ health/ready/diagnostic      │ 预计算 KPI/图/预览
   │ rows 分页                     ▼
                                 ECharts 大屏
```

### 3.1 关键设计决策

1. **监听目录而不是单文件。** Excel 保存常以“临时文件替换”完成，单文件监听会在替换后失效。
2. **解析放 worker。** 主线程持续响应 HTTP 和 SSE，不受大表解析阻塞。
3. **数据版本和状态版本分离。** `version` 只在成功解析后递增；`revision` 在解析、错误、missing 等状态变化时也递增。
4. **进程实例 ID。** 服务重启后版本号归零，浏览器通过 `instanceId` 识别新实例，避免误判为乱序旧响应。
5. **SSE 只发通知。** 事件 payload 只含版本和状态，不含原始数据，避免广播缓冲膨胀。
6. **大屏使用投影。** 聚合结果在 worker 中预计算，浏览器不再遍历全量行。

---

## 4. 模块设计

### 4.1 模块清单

| 模块 | 文件 | 职责 |
|---|---|---|
| 配置 | `server/config.mjs` | 环境变量解析、资源上限、Host 白名单、模式开关 |
| 领域错误 | `server/errors.mjs` | 统一错误结构：`code/status/stage/retryable` |
| 解析 | `server/parser.mjs` | 读取工作簿、类型推断、数据清洗、体检警告 |
| 投影 | `server/projection.mjs` | 兼容投影：KPI、主图、副图、预览 |
| 画布模型 | `server/document.mjs` | Document/Grid/ComponentSpec、编码校验、默认布局、可用位置 |
| Patch 引擎 | `server/patch.mjs` | add/remove/move/resize/remap/retitle/restyle、apply/revert/dry-run |
| 组件投影 | `server/component-projection.mjs` | 逐组件聚合、过滤、状态判定与旧版投影兼容 |
| Document 仓库 | `server/document-repository.mjs` | 画布状态、草稿审阅、栈顶撤销、缓存投影、重置/替换 |
| 画布持久化 | `server/document-store.mjs` | 原子写入、写去抖、损坏隔离、版本信封 |
| Worker 任务 | `server/workbook-worker.mjs` | 解析、投影、模拟变更均在 worker 内执行 |
| Worker 客户端 | `server/worker-client.mjs` | worker 生命周期、超时、异常重启、内存上限 |
| 摄入服务 | `server/ingest.mjs` | single-flight、重试、状态广播、过期结果丢弃 |
| 快照仓库 | `server/dataset.mjs` | 原子状态替换、元数据、投影、分页 |
| 文件监听 | `server/watcher.mjs` | chokidar 适配，只关心目标文件 |
| SSE | `server/sse.mjs` | 客户端管理、心跳、慢客户端背压处理 |
| 安全 | `server/security.mjs` | Host、CSRF、认证、请求体限制、路径校验 |
| HTTP | `server/http.mjs` | API 路由、静态资源、错误响应、健康接口 |
| 组合根 | `server/app.mjs` | 依赖装配、启动与优雅关闭 |
| 入口 | `server/index.mjs` | 信号处理、未捕获异常兜底、进程退出 |
| 前端 API | `web/api.js` | Fetch Facade，统一错误结构 |
| 前端应用 | `web/app.js` | 状态对齐、声明式画布、拖拽交互、隔离渲染、SSE 事件处理 |
| 界面 | `web/index.html` `web/style.css` | 低代码画布、配置弹窗、AI 面板、系统面板与样式 |
| AI 模型端口 | `server/ai/providers.mjs` | Rule / OpenAI 兼容 / Mock 三类 Provider |
| AI 上下文 | `server/ai/schema-card.mjs` | SchemaCard、DocumentDigest、schema 哈希 |
| AI 协议 | `server/ai/protocols.mjs` | 受约束输出校验、证据追溯、观点绑定 |
| AI 分析 | `server/ai/analysis.mjs` | 环比、连续下滑、离群点、贡献度（纯确定性计算） |
| AI 编排 | `server/ai/orchestrator.mjs` | 任务队列、缓存、冷却、预算、建议审阅队列 |
| 测试 | `tests/*.test.mjs` | 38 个自动化用例 |
| 基准 | `scripts/benchmark.mjs` | 可配置行数的数据规模测试 |

**配置入口：** 项目根目录 `.env`（由 `server/config.mjs` 启动时自动加载，模板见 `.env.example`）。系统环境变量优先级高于 `.env`，同名的系统变量不会被文件覆盖。AI 相关变量统一以 `AI_` 为前缀，密钥只在服务端读取，不会下发给浏览器。

### 4.2 依赖规则

1. `parser/projection` 不导入 HTTP、SSE 或 watcher。
2. `ingest` 只依赖注入的仓库、worker、通知器，不直接读取文件。
3. `http` 只调用应用对象暴露的方法，不直接触发解析库。
4. 前端不解析原始 Excel，只消费投影和分页数据。
5. 业务错误统一为 `AppError`，未知错误在 HTTP 层转为安全响应。

---

## 5. 领域模型

### 5.1 解析结果

```ts
interface ParsedDataset {
  sheetName: string;
  sheetNames: string[];
  headers: string[];
  schema: ColumnMeta[];
  rows: Array<Record<string, string | number | null>>;
  rowNumbers: number[];       // Excel 原始行号，用于稳定 diff
  rowCount: number;
  warnings: Warning[];
  parseMs: number;
}

interface ColumnMeta {
  name: string;
  type: 'number' | 'date' | 'string';
  nullCount: number;
  nullRate: number;
  distinct: number;
  sample: Array<string | number>;
}

interface Warning {
  level: 'info' | 'warn';
  code:
    | 'blank-header' | 'duplicate-header' | 'formula-cache'
    | 'total-row-skipped' | 'ragged-row' | 'extra-columns-recovered'
    | 'value-coerced-null' | 'percentage-normalized'
    | 'high-null' | 'high-cardinality';
  message: string;
}
```

### 5.2 公开快照元数据

```ts
interface DatasetMetadata {
  instanceId: string;    // 进程实例，重启后变化
  version: number;       // 成功解析次数
  revision: number;      // 任意状态变化次数
  status: 'idle' | 'parsing' | 'ready' | 'error' | 'missing';
  fileName: string;      // 仅文件名，不暴露绝对路径
  updatedAt: string;
  reason: string;
  sheetName: string;
  sheetNames: string[];
  headers: string[];
  schema: ColumnMeta[];
  rowCount: number;
  warnings: Warning[];
  parseMs: number;
  error: null | { code: string; stage: string; message: string };
}
```

### 5.3 投影模型

```ts
interface Projection {
  main: null | {
    x: ColumnMeta;
    y: ColumnMeta;
    points: Array<{ key: string; value: number }>;
    kind: 'line' | 'bar';
  };
  sub: null | {
    dimension: ColumnMeta;
    y: ColumnMeta;
    points: Array<{ key: string; value: number }>;
    kind: 'pie' | 'bar';
  };
  kpis: Array<{
    key: 'sum' | 'count' | 'average' | 'max';
    label: string;
    raw: number;
    delta: boolean;
    sub?: string;
  }>;
  preview: {
    headers: string[];       // 最多 7 列
    rows: Array<{            // 最多 12 行
      id: number;            // Excel 原始行号
      values: Array<string | number | null>;
    }>;
  };
}
```

---

## 6. 状态机与并发设计

### 6.1 Dataset 状态机

```
idle ──schedule──► parsing ──成功──► ready
                     │                   │
                     ├──错误──► error    ├──文件删除──► missing
                     │                   │
                     └──新事件──► parsing └──文件恢复──► parsing
error / missing 保留最后一次成功 rows 与 projection
```

### 6.2 Single-flight 摄入协议

1. 每次文件事件使 `requestedGeneration` 递增。
2. 同一时刻只允许一个解析任务；新事件只更新期望代数。
3. 解析完成后，如果结果代数小于最新期望代数，直接丢弃并继续处理最新事件。
4. 过期任务的失败同样不覆盖新任务成功后的状态。
5. 文件删除会置 `missing`，使在途解析结果失效。
6. 可重试错误：`EBUSY/EPERM/ENOENT/WORKER_CRASH`；不可重试错误立即进入 error。

### 6.3 前端状态对齐

1. SSE `ready/update/status/failure` 均触发一次同步。
2. 前端同步自身也是 single-flight：同步过程中收到新事件，只追加一次补拉。
3. 响应乱序时以 `revision` 较新者渲染。
4. `instanceId` 变化表示服务重启，重置 KPI 和单元格对比基线。

---

## 7. API 契约

### 7.1 HTTP 接口

| 方法 | 路径 | 说明 | 认证 |
|---|---|---|---|
| GET | `/api/meta` | 功能开关、是否需要认证 | 需要 |
| GET | `/api/state` | 快照元数据，不含 rows 和绝对路径 | 需要 |
| GET | `/api/projection` | 元数据 + KPI + 图表数据 + 预览 | 需要 |
| GET | `/api/rows?offset&limit` | 原始行分页，limit ≤ 500 | 需要 |
| GET | `/api/events` | SSE 实时通知 | Cookie |
| GET | `/api/health` | 存活与健康详情 | 需要 |
| GET | `/api/ready` | 就绪探针，非 ready 返回 503 | 需要 |
| GET | `/api/diagnostics` | 健康信息 + 最近本地日志 | 需要 |
| POST | `/api/reload` | 强制重读文件，返回 202 | 需要 |
| POST | `/api/simulate` | 仅 `npm run dev` 或 `ENABLE_SIMULATE=1` 注册 | 需要 |
| POST | `/api/session` | 用访问口令换取 HttpOnly Cookie | 公开但校验口令 |

### 7.2 SSE 事件

| 事件 | payload | 客户端动作 |
|---|---|---|
| `ready` | `{version, revision, status}` | 标记连接，并触发一次同步 |
| `status` | `{status, revision, reason}` | 更新状态点，触发同步 |
| `update` | `{version, revision, reason, rowCount, parseMs, updatedAt}` | 记录日志并拉取投影 |
| `failure` | `{revision, reason, code, stage, message}` | 保留旧图，显示错误 |

---

## 8. 错误处理与降级

| 层 | 错误 | 处理 | 用户可见 |
|---|---|---|---|
| 文件 | `EBUSY/EPERM` | 重试，指数间隔 | 短暂 parsing，不报错 |
| 文件 | `ENOENT` | 状态 missing | 提示文件不存在，旧图仍在 |
| 解析 | 空表/无表头/超限 | AppError + stage | 错误条 + 旧图 |
| worker | 超时/崩溃 | 终止并按需重启 | 保留旧图，指标记录 |
| HTTP | 未认证/跨站/路径非法 | 401/403/413 | JSON 错误 |
| 前端 | 单个图表渲染失败 | safeRender 隔离 | 其余组件正常 |
| 前端 | 拉取失败 | 状态点变红，等待下个事件 | 不清空大屏 |
| 进程 | 未捕获异常 | 结构化日志后安全退出 | 重启后浏览器通过 instanceId 恢复 |

原则：任何失败都不清空最后一次成功快照；错误信息必须带 `code/stage`。

---

## 9. 安全设计

### 9.1 网络边界

1. 默认 `HOST=127.0.0.1`。
2. `HOST=0.0.0.0` 或局域网地址时必须配置：
   - `ACCESS_TOKEN`：访问口令。
   - `ALLOWED_HOSTS`：允许的 `Host:port` 列表。
3. 违反 Host 白名单返回 403，阻断 DNS rebinding。

### 9.2 请求防护

1. 变更接口校验 `Origin` 与 `Sec-Fetch-Site`，拒绝跨站写操作。
2. 请求体默认 16KB 上限，声明大小和实际大小双重校验。
3. 认证支持 Bearer Token 或 HttpOnly Cookie；Cookie 使用 SHA-256 派生值。
4. Cookie 属性：`HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`。
5. 响应头：CSP、`nosniff`、`DENY`、`no-referrer`、CORP。

### 9.3 文件与解析防护

1. 静态资源使用 `realpath` + 路径相对校验，防目录穿越和符号链接逃逸。
2. 默认上限：文件 25MB、10 万行、100 列、200 万单元格。
3. worker 默认 512MB 堆内存和 30 秒执行上限。
4. 解析库使用 SheetJS 官方 0.20.3 tarball，规避 npm 0.18.5 的已知高危漏洞。
5. API 不返回本地绝对路径，只返回文件名。

### 9.4 前端防护

1. 所有插入 DOM 的用户数据均 HTML 转义。
2. ECharts tooltip 使用 `renderMode: 'richText'`，避免 HTML 注入面。
3. CSP 限制脚本仅同源，禁止 object、frame、base-uri。

---

## 10. 可观测性设计

### 10.1 指标

| 指标 | 含义 |
|---|---|
| `parseSuccess/parseFailure` | 成功和失败解析次数 |
| `parseRetries` | 文件锁等原因导致的重试 |
| `staleResults` | 过期结果丢弃次数 |
| `workerRestarts` | worker 超时或异常重启 |
| `slowClients` | SSE 慢客户端断开 |
| `rejectedRequests` | 安全拦截次数 |
| `lastParseMs` | 最近解析耗时 |
| `lastQueueWaitMs` | 事件等待解析的时间 |
| `lastSuccessAt` | 最后一次成功时间 |
| `lastError` | 最近错误 code/stage/message |

### 10.2 日志

1. 本地结构化 JSON 日志，默认容量 200 条环形缓冲。
2. `info` 记录启动、快照更新；`warn` 记录解析失败和文件消失；`error` 记录进程级异常。
3. 不上报遥测；`/api/diagnostics` 只在本机或认证后可见。

---

## 11. 性能与扩展性

### 11.1 当前实测

| 规模 | 指标 |
|---|---|
| 120 行 × 6 列 | 解析约 20ms |
| 1 万行 × 6 列 | 解析 411ms，worker 往返 549ms，主进程不受阻塞 |
| 十万行 KPI | 纯函数投影测试通过，无展开运算符栈溢出 |

### 11.2 扩展路径

| 需求 | 改动点 | 不需要改 |
|---|---|---|
| 更大文件 | 调整 `MAX_*`，评估 worker 内存 | 业务逻辑 |
| 多数据源 | 新 Source Adapter，输出同样的 `ParsedDataset` | 投影与前端 |
| 多 sheet | parser 增加选择策略 | 快照与 SSE |
| 新图表 | projection 输出扩展 + 前端 safeRender 新渲染器 | 摄入链路 |
| 桌面客户端 | Electron 主进程调用 `createApplication` | 前端与服务代码 |
| 历史版本 | SnapshotRepository 增加持久化 Adapter | 摄入调度 |

### 11.3 成本

1. 运行成本：单 Node 进程 + 一个 worker，常规数据量内存约 150MB。
2. 依赖成本：仅 chokidar、SheetJS、ECharts 三个直接依赖。
3. 开发成本：无数据库、无容器、无构建链，`npm install && npm run dev` 即可运行。

---

## 12. 可维护性与测试

### 12.1 测试矩阵

| 文件 | 覆盖 |
|---|---|
| `tests/parser.test.mjs` | 百分比、货币、负数、日期、原型污染、额外列、合计规则、资源上限、大数组 |
| `tests/ingest.test.mjs` | single-flight、过期失败不覆盖新成功、文件删除状态 |
| `tests/security.test.mjs` | 非回环配置约束、请求体限制、CSRF、路径穿越 |
| `tests/api.test.mjs` | HTTP API、分页、SSE、安全拦截、健康、认证会话、实例 ID |

### 12.2 命令

```bash
npm run sample       # 生成示例 Excel
npm run dev          # 开发模式，包含模拟变更按钮
npm start            # 生产模式，模拟接口关闭
npm test             # 16 个自动化测试
npm run benchmark    # 默认 1 万行；BENCH_ROWS=50000 可调
```

---

## 13. 部署与运维

### 13.1 本机使用

```bash
npm install
npm run sample
npm run dev
# 打开 http://127.0.0.1:3000
```

### 13.2 局域网大屏

```bash
HOST=0.0.0.0 PORT=3000 \
ACCESS_TOKEN=强口令 \
ALLOWED_HOSTS=192.168.1.10:3000 \
npm start
```

浏览器打开 `http://192.168.1.10:3000/?token=强口令`，口令换取 Cookie 后 URL 自动清理。

### 13.3 生命周期

1. `SIGINT/SIGTERM` 触发安全关闭。
2. 关闭顺序：watcher → ingest/worker → SSE → HTTP。
3. 未捕获异常记录日志后退出，浏览器在服务恢复后自动识别新实例。

---

## 14. 交付边界

### 14.1 已交付

1. 实时文件监听与解析。
2. Worker 隔离与资源上限。
3. 版本化快照、投影和分页。
4. SSE 通知与前端断线对齐。
5. 安全边界、健康检查、诊断日志。
6. 16 个基础自动化测试和性能基准。
7. P1：Document 模型、组件投影引擎、默认布局生成。
8. P1：Patch 引擎、dry-run、草稿审阅、栈顶撤销与不变式测试。
9. P1：声明式拖拽画布、列映射配置、组件降级与新增/删除/重置。
10. AI：LlmPort 端口与 Rule/OpenAI 兼容/Mock 三类 Provider。
11. AI：SchemaCard 最小上下文、受约束输出协议、一次修复循环。
12. AI：一句话建图（A1）与自动洞察（A2）全链路，建议采纳前必须人工审阅。
13. AI：看板自维护扫描、离线规则兜底、本地预算与冷却控制。
14. 画布持久化：原子写入、写去抖、损坏隔离、重启恢复版式。

### 14.2 未交付（后续阶段）

1. 在线模型接入实操验证（已接入第三方兼容端点，未做多供应商回归）。
2. 自动诊断面板与文本问数（A3）。
3. 指标口径治理与操作规则学习（A4）。
4. 历史版本与多画布（当前只持久化“当前这一版”）。
5. 桌面客户端打包。

---

## 15. P1 实现摘要与 AI 边界

### 15.1 Document 与 Patch（已实现）

1. Document 包含 `id/name/datasetId/grid/components/patches/revision`，只描述布局与编码，不复制数据行。
2. 组件支持 `kpi/line/bar/pie/table/text`，编码含 `x/y/series/agg/filter`。
3. Patch 支持 `add/remove/move/resize/remap/retitle/restyle`，带 `origin`、`reason`、`inverse`。
4. 全部布局修改必须通过 Patch；`dry-run` 不落库，草稿需人工采纳，撤销只允许栈顶。
5. `revert(apply(document))` 结构等价不变式由 `tests/document.test.mjs` 锁定。
6. 组件运行时状态为 `ok/degraded/invalid/empty`，列缺失或类型不匹配时局部降级，不影响整屏。
7. 数据保存与画布修改互不触发：Excel 更新只重算投影，布局变更只应用 Patch。
8. 新增接口：`GET/PUT /api/document`、`POST /api/document/patches`、`.../dry-run`、`.../revert`、`/api/document/reset`、`/api/document/drafts/:id/accept|reject`。
9. SSE 新增 `document` 事件，只携带画布 revision，不带原始数据。

### 15.2 AI 适配层（A1/A2，已实现）

1. `server/ai/providers.mjs`：`RuleProvider`（离线规则）/`OpenAiCompatibleProvider`（DeepSeek 等兼容端点）/`MockProvider`（测试），统一 `LlmPort` 接口，含超时与中止支持。
2. `server/ai/schema-card.mjs`：SchemaCard（列名/类型/基数/样例）与 DocumentDigest，模型永不接触数据行。
3. `server/ai/protocols.mjs`：ChartSpec/InsightSpec/MaintenanceSpec 白名单校验，列名必须存在、y 必须数值列、文案数字必须可追溯。
4. `server/ai/analysis.mjs`：确定性分析引擎（环比、连续下滑、离群点、贡献度），统计全部由代码完成。
5. `server/ai/orchestrator.mjs`：任务编排（缓存、冷却、并发限制、超时、降级）、建议队列（pending/accepted/rejected/stale）与 schema 哈希失效。
6. 接口：`POST /api/ai/chart`、`POST /api/ai/insights/scan`、`POST /api/ai/maintenance/scan`、`GET /api/ai/suggestions|insights|capabilities`、`POST /api/ai/suggestions/:id/accept|reject`。
7. SSE 新增 `ai` 事件；数据保存自动触发洞察（显著阈值 + 冷却控制）。
8. AI 产出的全部 Patch 以草稿形式进入审阅队列，采纳时校验 schema 哈希，画布已变则拒绝（stale）。
9. 接入真实模型：在项目根 `.env` 设置 `AI_PROVIDER=openai`、`AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL` 后重启进程；`AI_BASE_URL` 需与 `AI_ALLOWED_HOSTS` 白名单一致，未填 Key 时自动降级为 rule。

### 15.3 AI 边界（A3/A4，未实现）

1. 模型只接收 schema：列名、类型、基数、少量样例，不接收数据行。
2. 模型只输出受限 JSON，不输出可执行代码。
3. 输出必须过 Schema 校验，失败重试一次，再失败降级为建议卡片。
4. 数据事件触发 AI 提议 patch 时，仍需人工审阅采纳。
5. 所有统计计算保留在确定性代码中，模型只做意图翻译和文案。

### 15.4 画布持久化（已实现）

1. 存储文件：默认 `data/document.json`，可用 `DOCUMENT_FILE` 环境变量改路径；与数据同目录，便于整体备份。
2. 文件格式：信封 `{ schemaVersion, savedAt, document }`，`schemaVersion` 高于当前实现时拒绝加载并隔离，避免旧代码误读新结构。
3. 原子写入：先写 `document.json.tmp` 再 `rename`，进程中断不会留下半个 JSON。
4. 写去抖 250ms：连续拖拽只落盘一次；`close()` 时强制 flush，正常退出不丢最后一次改动。
5. 加载容错：JSON 损坏、结构校验失败、版本过高统一重命名为 `document.json.corrupt-<时间戳>` 并回落默认布局，配置文件问题不会阻止进程启动。
6. 恢复范围：版式、组件编码、标题、样式、revision 全部恢复；**补丁历史不恢复**，撤销栈仅存在于内存，避免未校验的历史补丁破坏 `revert(apply(doc))` 不变式。
7. 写入时机：默认布局生成、Patch 应用、撤销、重置、整份替换五处。
8. 可观测：`/api/health` 的 `document.storage` 暴露文件名、最后保存时间、是否待写入与最近一次错误。
9. 持久化失败不影响画布使用，只在日志与健康接口体现，不阻塞请求。

### 15.5 AI 交互策略：预览先行，采用/撤销贴在图表上（已实现）

早期版本把 AI 结论写成文字卡片，用户必须先在脑中把文案翻译成图表，再点「采纳」才知道效果。现行策略改为**结果先行**：

1. **服务端算预览，不只算计数**：`AiOrchestrator._preview()` 把建议里的 Patch 在当前 Document 上逐个 `dryRunPatch`，再对新增/改动的组件调用 `projectSpec()` 做一次真实投影，产出 `preview = { added[], changed[], removed[], steps[], grid, documentRevision, datasetVersion }`。`added/changed` 里的每一项都带完整 `spec` 与 `data`，前端可直接渲染。
2. **只投影受影响的组件**：不为整块画布生成影子投影，预览体量与建议数量线性相关，与画布规模无关。
3. **预览结果按 (建议 id, documentRevision, datasetVersion) 缓存**：最多保留 40 条；数据刷新或画布变化后自动重算，不会展示过期图。
4. **前端把预览画在原地**：`paintAiPreviews()` 在画布上叠加 `.ai-ghost` 卡片（复用正式渲染管线，实例 id 加 `__ai_preview__` 前缀），位置来自 dry-run 后的真实栅格；被替换/删除的原组件加 `.ai-superseded` 变暗。原卡片的轮廓保留在虚线边框之外，用户一眼看出「这块要变成什么样」。
5. **采用 / 撤销就在图表上方**：每张预览顶部是操作条（`AI 建图预览 | AI 修复预览` + 一句话说明 + 采用 + 撤销），不依赖侧栏文字。侧栏卡片降级为索引：显示步骤摘要与「定位预览」，避免文字描述压过画布。
6. **同一组件只叠一层预览**：多条建议指向同一块组件时先到先显示，避免两张图叠在一起导致坐标轴重复。
7. **隔离副作用**：预览渲染期间临时替换 `previousKpis/previousCells`，不污染正式组件的涨跌对比与单元格闪烁。
8. **重建后自动重挂**：画布 revision 变化会重建 DOM，`buildCanvas()` 重置预览签名，`render()` 末尾重新绘制预览层。
9. **撤销即拒绝**：预览上的「撤销」等于 `reject`，画布不产生任何 Patch；「采用」才走原有的人工采纳链路（含 schema 哈希与 revision 过期校验）。

---

### 15.6 多工作表：把 sheet 变成可对比的系列（已实现）

目标形态是**跨 sheet 汇总**：不要求每张表一套画布，而是把「哪张表」变成一列数据，直接做分表对比。

1. **解析入口**：`parseWorkbookSource(file, limits, { mode, sheetName })`。`merged` 逐表解析后按列名并集合并，追加虚拟列 `工作表`；`sheet` 只解析指定表，数据形状与旧版完全一致。
2. **虚拟列避让**：用户表里本来就有「工作表」列时，来源列自动改名为「工作表(分表)」并给出 `sheet-column-renamed` 警告，绝不覆盖用户数据。
3. **合并策略**：某张表没有的列补 `null`（`sheet-column-missing` 警告）；同名列类型冲突时保留原值并告警（`sheet-type-conflict`），不静默丢行。
4. **容错**：隐藏工作表跳过（`sheet-skipped`）；单张表解析失败只跳过该表，不让一个脏 sheet 拖垮整本工作簿；只有一张有效表时不生成虚拟列，保持旧数据结构。
5. **限额**：单表仍受 `MAX_ROWS`；新增 `MAX_SHEETS`（默认 50）与 `MAX_WORKBOOK_ROWS`（默认 20 万），合并超限返回 413。
6. **只驻留当前数据集**：内存里始终只有“当前数据源”的一份行数据，其余表只保留名称与行数估计；切换时在 worker 里重新解析，不常驻多份快照。
7. **接口**：`GET /api/sheets`（清单 + 行数 + 状态）、`POST /api/dataset/source {mode, sheet}`（切换并触发解析，202）；`/api/state` 增加 `mode / activeSheet / sheetColumn / sheets[]`。
8. **前端**：顶部「数据源」下拉列出“全部工作表（N）”与每张表；切换只发一次请求，随后由 SSE 的 update 驱动重绘。`N` 只统计可参与合并的表，隐藏表与解析失败的表不计入，并在下拉里置灰、标注原因。
9. **AI 边界**：切换数据源只换视图，不触发自动洞察/维护扫描；此前未审阅的建议统一标记 `expired`，避免画布上出现对旧 Schema 算出来的过期预览。
10. **示例数据**：`npm run sample:multi` 生成 `data/demo-multi.xlsx`（1–6 月共 6 张同构表、192 行 + 1 张隐藏说明页），把 `.env` 的 `TARGET_FILE` 指向它即可体验分表对比；注释掉该行恢复默认的 `data/sales.xlsx`。

**已知取舍**：切换数据源不改 Document，所以引用「工作表」列的组件在单表模式下会明确降级为“维度列不存在”，切回合并视图即恢复；每张表独立布局（Document v2 pages）尚未实现。

**过程中修掉的真实缺陷**：组件从 `invalid` 恢复为 `ok` 时，旧的 ECharts 实例还引用着已被替换掉的 canvas，`setOption` 画在脱离 DOM 的节点上导致永远空白——现在异常态直接 `dispose()` 并删除实例。

### 15.7 编辑态交互：三向缩放与下拉配色（已实现）

1. **三个手柄**：`resize-se`（右下，同时改宽高）、`resize-w`（左边界）、`resize-n`（上边界）。左/上手柄拖动时 `col/row` 与 `colSpan/rowSpan` 反向变化，**对侧边界保持不动**，这才是“向左拉宽”“向上拉高”。
2. **按最小尺寸隐藏**：`rowSpan <= 1` 不显示上边界手柄、`colSpan <= 1` 不显示左边界手柄，避免 1 行高的 KPI 卡片顶部挂着一条无意义的横条。
3. **本地重叠预检**：拖动时用其余组件的 span 做碰撞检测，超出可用空间就朝拖动反方向收缩，拖到相邻组件边上停住；不再出现“松手 → 后端 `assertNoOverlap` 拒绝 → 整体弹回”。
4. **原生下拉配色**：`<option>` 由系统绘制，不继承页面样式。深色主题必须显式声明 `color-scheme: dark` 并给 `option` 指定 `background-color / color`，否则会出现白底白字；禁用项单独降为灰字。

---

### 15.8 办公数据表兼容性验证（已实现）

`npm run sample:office` 生成 7 份不同业务形态的表到 `data/samples/`，每份都用独立实例（独立端口 + 独立 `DOCUMENT_FILE`）跑一遍「解析 → 默认布局 → 投影 → 无头浏览器截图」，结果归档在 `docs/screenshots/`。

| 表 | 结构特征 | 行数 | 结果 |
|---|---|---|---|
| 01 销售订单 | 文本订单号 + 日期字符串 + 金额/单价/数量 + 状态 | 120 | 7/7 ok，主指标自动选中「金额」 |
| 02 员工花名册 | 日期**单元格**（非字符串）+ 月薪 + 一位小数评分 | 86 | 7/7 ok，日期轴 2018–2025 |
| 03 库存台账 | SKU + 8 列含两个“金额类”数值 + 盘点日 | 96 | 7/7 ok，主指标选中「库存金额」 |
| 04 费用报销 | 150 行 + 6 部门 + 5 种审批状态 | 150 | 7/7 ok |
| 05 项目工时 | 小数工时（0.5 步长）+ 是/否 文本列 | 140 | 7/7 ok，表格保留 1 位小数 |
| 06 客服工单 | **带时分的时间字符串** + 满意度 1–5 | 110 | 7/7 ok，时间列识别为日期并做趋势图 |
| 07 月度经营报表 | 第 1 行大标题 + 表头在第 2 行 + 末行合计 + 百分比列 | 36 | 7/7 ok，标题行跳过、合计行跳过、毛利率按小数显示 |

**验证这一轮修掉的 3 个真实缺陷**

1. **带时分的时间列被判成文本**：`toDateKey` 只认 `2026-01-06` / `2026/1/6` / `2026年1月6日`，遇到 `2026-01-06 14:23` 直接返回 null。后果是客服工单没有日期轴，主图退化成「按渠道」柱状图。现在正则兼容 `2026-01-06 14:23`、`2026/1/6 9:05:30`、ISO 的 `T…Z`，并校验小时 0–23、分钟 0–59；聚合粒度仍是天。
2. **默认指标取第一个数值列**：`pickColumns` 用 `numbers[0]`，销售订单于是显示“数量合计 3,430”，库存显示“库存数量”。现在按 `销售额 / 金额 / 收入 / 毛利 / 成本 / 费用 / 工资 / 数量 / 工时…` 的顺序找最像结果口径的列，找不到才回退第一列。01 由数量 3,430 → 金额 836.2 万，03 由库存数量 → 库存金额 7,255 万。
3. **表格数字一律按整数格式化**：`Intl.NumberFormat({ maximumFractionDigits: 0 })` 把毛利率 `0.325` 显示成 `0`、工时 `1.5` 显示成 `2`。改为分级精度：整数千分位、`|x| ≥ 1000` 保留 1 位、`|x| ≥ 1` 保留 2 位、小于 1 保留 3 位。

另外把折线/柱状图的 `grid.right` 从 16 提到 34，避免最后一个日期标签被画布右边缘裁掉半截（01、03 的旧截图里能看到 `2026-06-0…`）。

### 15.9 UI 重设计：NOVA 深空控制台（已实现）

设计规格见 `design-specs/nova-console-ui.md`（按 `ui-ux-pro-max-skill` 的「需求解析 → 设计令牌 → 组件规格 → 布局蓝图 → 前端实现指引 → 校验清单」六段式交付）。目标风格：未来科技 + 简洁。

**只改表现层**：`web/index.html` 结构、`web/style.css` 全量重写、`web/app.js` 的三处 ECharts 常量。**没有重命名任何类名或 id**，47 项既有测试与 DOM 契约全部保持，测试从 50/50 通过。

设计决策与依据：

| 决策 | 理由 |
|---|---|
| 全幅控制台替代居中 1480px 卡片堆叠 | 高度用 `1fr` 分配，删掉 `max-height: calc(100vh - 330px)` 这个魔数；窗口一变不再露出空白或压扁画布 |
| 结构靠发丝线，不靠边框堆叠 | 底部三栏合并成「一块」面板，内部只用 1px 竖线切分，去掉三层卡片边框的视觉噪音 |
| 单一强调色 `#22D3EE` + AI 专属色 `#8B7BFF` | 青色只表达「可交互 / 实时 / 当前」，紫色只表达「机器建议」，两者色相拉开 60° 以上，语义不混淆 |
| KPI 数字改等宽 + `tabular-nums` | 数据每秒多次刷新，比例字宽跳动会让整屏「抖动」；等宽是稳定感的来源 |
| 主按钮不做实心填充 | 一屏出现两个实心青块会互相抢注意力，改用青色描边 + `--accent-ink` 文字 |
| 不做 `backdrop-filter` 玻璃卡 | 卡内含 canvas 图表，模糊会在滚动与 resize 时反复重绘，用「上浅下深渐变 + 顶部 1px 高光」模拟更划算 |

修掉的三个**真实缺陷**：

1. **微标签对比度不足**：原 `--text-3: #5D708A` 在 `#0A0F18` 上只有 3.7:1，而它被用在 10px 的版本号、提示、日志上，不满足 WCAG AA。抬到 `#7488A4`，实测 5.3:1。
2. **矮窗口下图表压到面板上**：`.stage` 一度设了 `min-height: 300px`，当 `1fr` 行分配不足时网格项会撑破自己的行、向下溢出，1280×620 下折线图直接盖住「数据体检 / AI 助手 / 事件流」。改为 `min-height: 0` 让画布内部滚动，并用 `@media (max-height: 820px / 700px)` 逐级压缩底部三栏；低于 600px 时放弃「一屏铺满」，整页滚动。
3. **`.chip` 改成 flex 后省略号失效**：`text-overflow` 只作用于块容器，长文件名会被硬裁。改回 `inline-block + line-height`，只给内含下拉的 `.source-chip` 保留 flex。

配套新增 `scripts/screenshot.mjs`：走 CDP 而不是 `--virtual-time-budget`。原因是页面持有 SSE 长连接，网络永不空闲，`--virtual-time-budget` 会一直等不到超时；脚本自己控制导航、等待、`Runtime.evaluate`（可注入操作、读回状态）与 `Page.captureScreenshot`（支持 `--clip` 放大局部），并回传控制台错误数。实测 1600×1000 / 1920×1080 / 1280×860 / 1280×700 / 1280×620 五档均 0 console error。

**AI 助手改为右侧栏**：原先它是底部三栏中的一栏，高度被压在 232px，一张建议卡加三个按钮就把面板塞满。现在移进 `.workspace`（`grid-template-columns: minmax(0,1fr) 336px`）与画布同高、各自滚动，竖向可用高度约 600px，能放 2–3 张建议卡。底部系统区从三栏改为两栏（数据体检 / 事件流，高度 232 → 188）。

配套三个细节修正：

1. **侧栏头部两行**：模型标识约 45 字符（`外部模型 · deepseek-v4.1-flash-1017 · schema-only`），挤在「AI 助手」右侧会把标题压成竖排两行。改为 `h2` 独占一行、`.hint` 用 `flex: 1 0 100%` 换行并省略号截断。
2. **空状态不再撑出空洞**：建议区若 `flex: 1 1 auto`，仅有一条「暂无待审阅建议」时会把洞察顶到栏底，中间留一大片空白。改为建议区 / 洞察区都按内容顺序排（`flex: 0 1 auto` + `max-height: 58% / 34%`），剩余空间留在栏底。
3. **面板分隔线作用域收窄**：`.panel` 的 `border-left` 原本是通用规则，AI 面板离开 `.system` 后会被多画一条左边线，改为 `.system .panel` 限定。

断点：≥1400px 侧栏 336px；1240–1399px 296px；<1240px 整栏落到画布下方（`max-height: 380px`），避免把 12 列栅格压到 860px 以下。

---

## 16. 验收标准

1. `npm test` 全部通过（50 项）。
2. `npm audit` 无已知漏洞。
3. `npm run dev` 启动后，点击“模拟一次变更”，SSE 收到 update，前端 KPI 或图表变化。
4. 删除目标文件后大屏不清空，状态变为 missing。
5. 恢复文件并保存后状态回到 ready。
6. 生产模式访问 `/api/simulate` 返回 404。
7. 局域网配置缺少口令或 Host 白名单时进程拒绝启动。
8. 重启服务后，已打开的浏览器页面能自动切换到新实例数据。
9. 首次加载数据生成默认 Document，7 个组件状态全部可用。
10. 布局增删、移动、缩放、改列均产生可撤销 Patch；越界和重叠请求返回 400。
11. 系列列缺失时组件 degraded，度量列缺失时组件 invalid，但表格和其余组件继续渲染。
12. 草稿 Patch 未经采纳不改变正式画布。
13. 一句话建图输出非法时自动降级为规则模式，任务状态可查询。
14. AI 建议采纳前画布发生变更时返回 stale，拒绝执行过期补丁。
15. 洞察文案中的数字必须能在分析证据中追溯，否则输出校验失败。
16. 修改布局后重启进程，版式、标题与 revision 保持不变；删除或写坏 `document.json` 后进程仍能启动并回落到默认布局。
17. 输入「按地区看毛利排行」后，画布上直接出现该图表预览，图表上方有「采用 / 撤销」；此时组件数不变。
18. 点「采用」后预览消失、组件数 +1 并落盘；点「撤销」后预览消失、组件数与画布内容保持不变。
19. 维护类建议同样在**被修的那块组件**上原地预览修好后的结果，并在数据刷新后自动重算，不展示过期数字。
20. 多表工作簿启动后，`/api/state` 的 `headers` 含「工作表」列，`rowCount` 为各可见表之和，隐藏表被跳过并给出 `sheet-skipped` 警告。
21. 页面顶部「数据源」可在“全部工作表”与单张表之间切换：切换后 KPI、折线图、表格同步变化，无需改 `.env` 或重启进程。
22. 单表模式下引用「工作表」列的组件显示“维度列不存在”，切回合并视图后自动恢复渲染（不再是空白 canvas）。
23. 切换数据源不触发 AI 自动维护建议；切换前未审阅的建议被标记 `expired`，画布上不留过期预览。
24. 合并后总行数超过 `MAX_WORKBOOK_ROWS` 时返回 413，且保留上一版快照。
25. 编辑模式下每个组件有左、上、右下三个缩放手柄：拖左边界向左可加宽**且右边界保持不动**，拖上边界向上可加高且下边界不动；只有 1 行高的 KPI 不显示上边界手柄，1 列宽不显示左边界手柄。
26. 拖动缩放撞到相邻组件时停在边界处（本地预检），不会松手后被后端拒绝再整体弹回。
27. 「数据源」下拉展开后为深底浅字，选中项高亮、禁用项明显变灰，不存在白底白字看不清的情况。
28. `2026-01-06 14:23`、`2026/1/6 9:05:30`、`2026-01-06T14:23:00Z` 均被识别为日期列并按天聚合；`14:23` 与 `2026-01-06 25:00` 不被误判为日期。
29. 默认布局优先选金额类列当主指标：表中同时有“数量/单价/金额”时选金额，同时有“库存数量/库存金额”时选库存金额；只有过程量时回退第一个数值列，不生成空指标。
30. 表格中的小数不会被抹成整数：`0.325` 显示 `0.325`、`1.5` 显示 `1.5`、`385424.5` 显示 `385,424.5`。
31. 界面为全幅控制台：顶栏 / 工具条 / 画布 / 三栏系统区 / 页脚用 `1fr` 分配视口高度，画布始终占满剩余空间；窗口高度变化时不出现空白带或被压扁。
32. 1280×620 这类矮窗口下，画布内容被裁在自身视口内（内部滚动），不会覆盖「数据体检 / AI 助手 / 事件流」；页脚仍可见。
33. 所有 < 12px 的灰色文字对比度 ≥ 4.5:1（版本号、提示、日志、表头）；涨跌仍为红涨绿跌。
34. 「数据源」下拉展开为深底浅字、选中项高亮、禁用（隐藏表）明显变灰；长文件名 chip 超出宽度时显示省略号而不是硬裁。
35. AI 预览层为不透明背景，采用 / 撤销条贴在 ghost 卡片顶部，左侧紫右侧青；预览时被替换的旧组件降到 28% 不透明度，不出现两张图叠在一起。
36. AI 助手是画布右侧的独立侧栏（≥1240px），与画布同高、内部独立滚动，剩余高度留白在栏底；窗口 <1240px 时整栏落到画布下方，不把 12 列栅格压到 860px 以下。
37. 侧栏「AI 助手」标题与模型标识分两行：标题永不折行，模型标识超长时以省略号截断。
38. 侧栏内有建议卡时，建议卡与洞察按内容顺序上下紧挨，不被 `flex: 1` 顶到栏底留出大片空洞；底部系统区为标准两栏（数据体检 / 事件流），AI 面板离开后不残留多余分隔线。
31. `npm run sample:office` 生成的 7 份办公表逐份启动后，7 个组件均为 `ok`，无空 canvas、无错误提示。
