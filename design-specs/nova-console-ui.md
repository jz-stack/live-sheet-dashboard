# NOVA · 深空控制台 — UI 设计方案

> 交付物对应 `ui-ux-pro-max-skill` 五步 SOP：需求解析 → 设计令牌 → 组件规格 → 布局蓝图 → 前端实现指引，末尾附校验清单。
> 实施范围：`web/index.html`、`web/style.css`、`web/app.js`（ECharts 主题常量）。

---

## 一、需求解析

| 字段 | 取值 | 依据 |
|---|---|---|
| `project_type` | 数据可视化控制台 / 低代码画布（B 端工具） | 现有产品：Excel 监听 → 解析 → SSE → 画布 |
| `target_platform` | Web 桌面优先（≥1280px），1024px 降级，不做移动端 | 大屏场景，操作依赖拖拽与多列栅格 |
| `user_persona` | 业务分析 / 运营 / 值班监控人员，长时间盯屏 | 需要低视觉疲劳、高数字可读性 |
| `core_tasks` | ① 一屏看清当前核心指标 ② 发现异常并定位到具体图表 ③ 用一句话让 AI 改图并当场确认 | 对应 KPI / 数据体检 / AI 预览条 |
| `brand_tone` | 未来科技 · 简洁（克制、精密、冷静） | 用户原始诉求 |
| `constraints` | ① 现有 47 项测试与 DOM 契约不可破坏 ② 深色主题 ③ 涨跌遵循中国习惯（涨红跌绿） ④ 原生下拉需显式深色 option ⑤ AI 预览层必须不透明 | 已发生的真实缺陷 |

### 设计策略

「未来科技」不等于加发光和粒子。真正的科技感来自 **精密**：等宽数字、发丝级分隔线、克制的单一强调色、明确的层级刻度。「简洁」不等于留白空荡，而是 **每一种颜色、每一根线都有语义**。

因此本方案确立三条硬规则：

1. **一屏一强调色**：`#22D3EE` 青色只用于「可交互 / 当前状态 / 实时」，装饰性发光一律压到 8% 以下透明度。
2. **结构靠线，不靠框**：面板之间用 1px 发丝线切分，而非给每个块加边框和阴影层层堆叠，减少「卡片套卡片」的视觉噪音。
3. **数字用等宽**：所有可变化的数值使用 `tabular-nums` + 等宽字体，避免刷新时字宽跳动——这是数据大屏「稳」的来源。

---

## 二、设计令牌表

### 2.1 颜色

| 令牌 | 值 | 语义 / 推导依据 |
|---|---|---|
| `--void` | `#04060A` | 页面底色。带轻微蓝偏的近黑，比纯黑柔和，避免 OLED 上的硬边 |
| `--surface-1` | `#0A0F18` | 一级面板（组件卡、系统面板） |
| `--surface-2` | `#0E1521` | 二级面板（输入框、内嵌表格头） |
| `--surface-solid` | `#0C121C` | **必须不透明**：AI 预览层背景，防止下层旧图透出形成「双坐标轴」 |
| `--line` | `rgba(126,164,220,0.10)` | 发丝分隔线。取蓝相而非中性灰，与底色同色温 |
| `--line-strong` | `rgba(126,164,220,0.22)` | 控件边框、可拖拽边界 |
| `--accent` | `#22D3EE` | 主强调色（青）。色调 187°，饱和度 82%，亮度 55% |
| `--accent-ink` | `#A5F3FC` | 强调色上的文字 / 浅色描边文字，对比度 ≥ 9:1 |
| `--accent-dim` | `rgba(34,211,238,0.14)` | 强调色底衬（active 态、AI 预览条渐变起点） |
| `--violet` | `#8B7BFF` | AI 专属色。与青色拉开色相 60° 以上，让「机器建议」和「用户操作」在视觉上属于两个系统 |
| `--up` | `#FF5D6C` | 上涨 / 正增长（**红**，中国习惯） |
| `--down` | `#2BE38A` | 下跌 / 负增长（**绿**，中国习惯） |
| `--warn` | `#FBBF24` | 降级、数据告警 |
| `--text-1` | `#E9F0FB` | 主文本，对比度 16.8:1 |
| `--text-2` | `#93A5BF` | 次要文本，对比度 7.6:1 |
| `--text-3` | `#7488A4` | 微标签，对比度 5.3:1（**刻意抬亮**，原方案 `#5D708A` 仅 3.7:1，10px 小字不过 AA） |

对比度全部按 WCAG 2.1 计算，正文与微标签均 ≥ 4.5:1。

### 2.2 字体

| 令牌 | 值 |
|---|---|
| `--font-ui` | `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif` |
| `--font-mono` | `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace` |

| 层级 | 字号 / 行高 | 字重 | 用途 |
|---|---|---|---|
| micro | 10px / 1.2，`letter-spacing: .16em`，大写 | 500 | 版本号、LIVE、面板英文角标、底部说明 |
| xs | 11px / 1.55 | 400 | 提示文案、日志、状态徽标 |
| sm | 12px / 1.6 | 400 | 按钮、表格、次要正文 |
| base | 13px / 1.6 | 500 | 组件标题、面板标题 |
| lg | 16px / 1.2 | 600 | 品牌字标 |
| kpi | `clamp(20px, 2.4vw, 30px)` / 1.1 | 500，等宽 | KPI 数值 |

数字族（`.value`、`td.num`、`.delta`、`.ver`）统一 `font-variant-numeric: tabular-nums`；标题、标签不使用等宽，避免中文等宽字体的怪异字距。

### 2.3 间距（4px 基准）

`--s1:4px` `--s2:8px` `--s3:12px` `--s4:16px` `--s5:20px` `--s6:24px` `--s8:32px`

- 页面内边距：`16px`
- 组件卡内边距：`14px 16px 12px`
- 卡内标题到图表：`10px`
- 系统面板内边距：`14px 16px`

### 2.4 圆角与投影

| 令牌 | 值 | 用途 |
|---|---|---|
| `--r-ctl` | `6px` | 按钮、输入框、下拉 |
| `--r-card` | `14px` | 组件卡、面板 |
| `--r-stage` | `18px` | 画布视口 |
| `--r-pill` | `999px` | chip、状态徽标 |
| `--ring` | `0 0 0 1px var(--accent-dim), 0 0 18px -6px rgba(34,211,238,.55)` | 焦点 / 当前项光晕 |
| `--shadow-card` | `0 1px 0 rgba(255,255,255,.02) inset, 0 10px 30px -18px rgba(0,0,0,.9)` | 卡片轻微离层感 |

**不用大面积高斯模糊**：组件卡内含 canvas 图表，`backdrop-filter` 会在滚动和 resize 时触发重绘，实测收益小于成本。玻璃感改用「上浅下深的线性渐变 + 顶部 1px 高光」模拟。

### 2.5 动效

| 场景 | 时长 / 曲线 |
|---|---|
| hover / 边框变色 | 160ms ease |
| 面板入场、AI ghost 出现 | 280ms `cubic-bezier(.22,1,.36,1)` |
| LIVE 脉冲 | 1.4s ease-out，只改 box-shadow |
| 数据跳动 flash | 900ms ease-out |

全部包在 `@media (prefers-reduced-motion: reduce)` 中降级为 `0.01ms`。画布扫描光带默认关闭，仅 `prefers-reduced-motion: no-preference` 且非编辑模式时启用，8s 一次、透明度 3%。

---

## 三、组件规格卡

### 3.1 Button（`--ctl` 幽灵按钮）

| 属性 | 默认 | Hover | Active / 选中 | Disabled |
|---|---|---|---|---|
| 背景 | `transparent` | `rgba(126,164,220,.07)` | `--accent-dim` | `transparent` |
| 文字 | `--text-2` | `--text-1` | `--accent-ink` | `--text-3` |
| 边框 | `1px --line` | `1px --line-strong` | `1px rgba(34,211,238,.5)` | `1px --line` |
| 光标 | pointer | pointer | pointer | not-allowed，`opacity:.45` |

尺寸：高 30px，水平内边距 12px，字号 12px，圆角 6px。主按钮（`.primary`）改用 `--accent` 描边 + `--accent-ink` 文字，**不做实心填充**——一屏里出现两个实心青块就会互相抢注意力。

无障碍：`:focus-visible` 用 `--ring`，且加 `outline-offset: 2px`，不依赖颜色单一维度。

### 3.2 Chip（只读信息胶囊）

高 24px，`--r-pill`，背景 `--surface-1`，边框 `--line`，文字 11px `--text-2`，前缀可用 mono 微标签。最大宽 300px，溢出省略号 + `title` 全文。

### 3.3 Source Select（数据源切换）

嵌入 chip 内部，无边框、透明底、自绘 4px 双三角箭头。**必须保留** `color-scheme: dark` 与显式 `option` 配色（`#0E1521` / `#E9F0FB` / `:checked` 用 `#10303A`），这是历史真实缺陷：原生 option 由系统绘制，不继承页面 color，深色主题下会变成白底白字。合并视图时 chip 边框转为 `rgba(34,211,238,.45)`。

### 3.4 Component Card（画布组件）

- 结构：`head`(标题 + 状态徽标 + 编辑态操作) / `body`(图表·KPI·表格·文本) / 三个 resize 手柄
- 背景：`linear-gradient(180deg, #131B28, #0A0F18)`，边框 `1px --line`，圆角 14px
- 顶部高光：`::before` 一条 `linear-gradient(90deg, transparent, rgba(34,211,238,.35) 20%, rgba(34,211,238,.35) 80%, transparent)` 的 1px 线，hover 时透明度 0 → 1
- 编辑态：`outline: 1px dashed rgba(34,211,238,.45)`，`outline-offset: 2px`；拖拽中改实线 + `--ring`
- 状态：`status-degraded` 边框/徽标转 `--warn`，`status-invalid` 转 `--up`，`status-empty` 徽标隐藏
- 被 AI 替换态 `.ai-superseded`：`opacity:.28`，`filter: saturate(.4)`，让新图成为唯一焦点

### 3.5 KPI

数值等宽 500 字重，`--text-1`；下方 delta 11px。涨红跌绿，平盘用 `--text-3`。数值刷新用 900ms 背景 flash，不用数字滚动——滚动在每秒多次刷新时会变成糊。

### 3.6 Resize Handle（三向）

| 手柄 | 位置 | 光标 | 视觉 |
|---|---|---|---|
| `.resize-se` | 右下角 16×16 | `nwse-resize` | 45° 双斜线，默认 `rgba(34,211,238,.5)`，hover 实心 |
| `.resize-w` | 左边界居中 6×30 | `ew-resize` | 竖向胶囊，`rgba(34,211,238,.38)` |
| `.resize-n` | 上边界居中 30×6 | `ns-resize` | 横向胶囊，同上 |

`rowSpan<=1` 隐藏 `.resize-n`，`colSpan<=1` 隐藏 `.resize-w`（由 JS 控制 `display`）。hover/focus 时统一提到 `--accent`。

### 3.7 AI Preview Bar（采用 / 撤销）

贴在 ghost 卡片顶部，`margin` 负向铺满整卡宽度，高 34px。背景 `linear-gradient(90deg, rgba(139,123,255,.28), rgba(34,211,238,.12))`——左紫右青，暗示「AI 产出 → 用户采纳」。内含：`AI 建图` 徽标、单行摘要（溢出省略）、`采用`(实心青) 与 `撤销`(幽灵) 按钮。

`.ai-ghost` 本体：**不透明** `--surface-solid` 背景 + 1px 虚线青边 + `0 0 0 1px` 内环 + 深投影，入场 280ms 上浮。

### 3.8 Insight Row / Warn Item

左侧 2px 语义色边（`critical`→红、`warning`→琥珀、默认→青），内文 12px。不加重背景，靠左边线区分严重度。

### 3.9 Dialog

宽 `min(460px, 100vw - 32px)`，`--surface-1`，圆角 14px，`::backdrop` 为 `rgba(2,4,8,.78)` + 4px 模糊。表单标签 11px `--text-3` 大写微标签风格，输入框高 34px。

### 3.10 Log Row

等宽 11px，时间戳 `--text-3`、消息 `--text-2`，`hot` 条目消息转 `--accent`。悬停整行轻微提亮。

### 3.11 AI Rail（右侧栏）

- 容器：与画布同高，`336px`（≤1400px 时 296px），`--surface-1` 底 + `1px --line` 边 + `--r-card` 圆角，`overflow: hidden`
- 顶部标识：`::before` 一条左右各缩进 16px 的紫色渐变线（`transparent → rgba(139,123,255,.7) → transparent`），标题前 4px 紫色圆点带 `0 0 7px` 光晕
- 头部两行：`AI 助手`（11px 大写字距）+ 模型标识（10px mono，`flex: 1 0 100%` 独占一行，超长省略号）
- 指令框：30px 高，聚焦时边框转紫（`rgba(139,123,255,.55)`）而非青——它属于「向 AI 提要求」，不属于全局交互
- 建议卡：紫边 + 紫向渐变底；`建图` 用紫徽标、`维护` 用琥珀徽标；摘要 2 行截断、理由 3 行截断
- 纵向分配：建议区 `flex: 0 1 auto; max-height: 58%`，洞察区 `flex: 0 1 auto; max-height: 34%`，剩余空间留在栏底
- 断点：≤1239px 整栏落到画布下方，`max-height: 380px`，避免挤压 12 列栅格

---

## 四、页面布局蓝图

### 4.1 分区（1440×900 参考）

```
┌─────────────────────────────────────────────────────────────────────┐ 16px
│ ◈ NOVA  实时数据大屏  v1.4  ●LIVE   ··· chips/source/action         │ 52  header
├─────────────────────────────────────────────────────────────────────┤ 1px hairline
│ [编辑布局][撤销上一步][恢复默认] │ [类型▾][添加组件]      hint →      │ 40  toolbar
├────────────────────────────────────────────────┬────────────────────┤
│ ⌐                                              ¬│ ▏AI 助手           │
│   ┌KPI┐┌KPI┐┌KPI┐┌KPI┐   ← 12 列 × 72px        │  model · schema    │
│   ┌──── 趋势主图 ────┐┌── 分表图 ──┐            │ [一句话建图…][建图] │
│   ┌─ 明细表 ─────────┐┌ 体检 ┐                  │ [洞察][体检]        │
│ ∟                                              ⌐│ ┌ 建议卡 ┐         │ 1fr workspace
│                                                  │ │        │         │
│                                                  │ 洞察列表           │
│                                                  │                    │ 336px
├────────────────────────────────────────────────┴────────────────────┤
│ 数据体检 │ 事件流                                                    │ 188  system
├─────────────────────────────────────────────────────────────────────┤
│ 本地服务 · 文件监听 → 解析 → SSE → …                                 │ 26  foot
└─────────────────────────────────────────────────────────────────────┘
```

**关键改动**：整体由「居中 1480px 卡片堆叠」改为 **全幅控制台**，用 `100vh` 网格 `grid-template-rows: auto auto minmax(0,1fr) auto auto` 分配高度。原方案用 `max-height: calc(100vh - 330px)` 这种魔数，窗口一改就露出空白或压扁画布；现在画布永远吃满剩余空间。

**AI 助手改为右侧栏**（原先是底部三栏中的一栏）。理由：AI 是「对着画布说话」的操作，眼睛不该在画布和 232px 高的角落之间来回跳；改成贴住画布的竖栏后，指令框、建议卡、采用/撤销都在画布右侧同一视野内，同时侧栏竖向空间（≈600px）远大于原来的 232px，能放下 2–3 张建议卡而不必滚动。

- 工作区：`.workspace` 为 `grid-template-columns: minmax(0,1fr) 336px`，侧栏与画布同高，各自内部滚动。
- 栅格：画布内部沿用 12 列（`Document.grid.columns`），列间距 `gap: 12px`，行高 72px，画布内边距 12px。
- 系统区：剩两栏 `1fr 1.25fr`，**外框一个整体**，面板之间仅 1px 竖线——减少独立卡片的边缘噪音。
- 侧栏身份标识：顶部一缕紫色渐变线 + 标题前的紫色圆点，与画布组件卡（青色 hover 高光）区分开「用户内容」与「机器建议」。
- 侧栏头部：标题与模型标识分两行。模型标识一行约 45 字符，挤在标题右侧会把「AI 助手」压成竖排两行。
- 内容流：建议区与洞察区都按内容高度顺序排（`flex: 0 1 auto` + `max-height`），剩余空间留在侧栏底部；若让建议区 `flex:1` 吃满剩余高度，空状态下会把洞察顶到栏底，中间留出一大片空洞。
- 最大宽度 1920px 居中，超宽屏两侧留底色，避免 4K 下单卡宽到失去比例。

### 4.2 断点

| 断点 | 布局策略 |
|---|---|
| ≥ 1400px | 侧栏 336px，header 单行 |
| 1240–1399px | 侧栏 296px，toolbar hint 换行到第二行 |
| 1100–1239px | 侧栏落到画布下方（`max-height: 380px`），避免把 12 列栅格压到 860px 以下 |
| < 1100px | 系统区单列堆叠；画布横向滚动（`min-width: 860px` 保留，栅格不压缩到不可读） |
| 高度 < 700px | 先压缩底部两栏（188 → 148px），保证画布与侧栏都有可用高度 |
| 高度 < 600px | 放弃「一屏铺满」，整页滚动，不把画布压成一条缝 |

### 4.3 关键路径

`扫视 KPI → 发现红/绿 delta → 看主图趋势 → 读体检告警 → 侧栏发一句 AI 指令 → 画布上直接看 ghost → 点「采用」`

路径上每一步都有独立视觉锚点：KPI 用大字号、delta 用色相、主图用最大面积、体检用左侧色边、AI 用紫→青渐变条。

---

## 五、前端实现指引

### 5.1 变量落点

全部令牌写在 `:root`，命名前缀 `--`，按「颜色 → 字体 → 间距 → 圆角 → 动效」分组注释。**不允许在规则里写裸色值**，唯一例外是 ECharts 常量（canvas 取不到 CSS 变量，需在 `app.js` 用字面量，并注明与 `--accent` 同步）。

### 5.2 命名规范

沿用现有 BEM-lite：块 `.component` `.panel` `.ai-card`，元素 `.component-head` `.ai-card-head`，状态用 `.is-*` / `.status-*` / `.ai-*` 前缀。**本轮不重命名任何类**——47 项测试与 DOM 契约依赖这些选择器。

### 5.3 无障碍要点

- 所有按钮、下拉、可拖拽手柄 `:focus-visible` 可见环
- 状态徽标不能只靠颜色：`降级 / 配置异常 / 暂无数据` 都有文字
- 装饰性图层（画布网格、角标、扫描光）全部 `aria-hidden="true"` + `pointer-events:none`
- 表格 `th` 保持 `scope` 语义（现有实现已用 `thead/tbody`）
- 尊重 `prefers-reduced-motion`

### 5.4 ECharts 主题同步

`app.js` 顶部三处常量改为新色板：

```js
const PALETTE = ['#22D3EE','#8B7BFF','#2DD4A7','#F5B23D','#FF6B81','#5B9BFF','#C084FC','#94E34A'];
AXIS axisLine rgba(126,164,220,.14) / axisLabel #93A5BF / splitLine rgba(126,164,220,.06)
TOOLTIP backgroundColor '#0B1018F2' / borderColor 'rgba(126,164,220,.20)' / textStyle #E9F0FB
pie itemStyle.borderColor '#0A0F18'（与新卡底色一致，避免环形图分片出现旧底色描边）
areaStyle 渐变起点 rgba(34,211,238,.18)
```

图例、轴标签统一用 `--text-2` 的等价色，保证「图内文字」和「卡内文字」是同一套灰阶。

### 5.5 已知坑位（必须在实现中保留）

| 坑 | 约束 |
|---|---|
| ghost 半透明 | `.ai-ghost` 必须 `background-color: var(--surface-solid)` 实心 |
| 原生 select | `color-scheme: dark` + `option` 显式配色，缺一不可 |
| 拖拽手柄 | 三向都要有；`n`/`w` 在对侧边界固定，方向反算 |
| 图表实例 | 组件从 invalid 恢复时必须 `dispose()` 旧实例，否则画到脱离 DOM 的 canvas |
| 数字精度 | 表格用分级精度（整数 / ≥1000 保留 1 位 / ≥1 保留 2 位 / <1 保留 3 位），不能一刀切取整 |

---

## 六、校验清单

- [x] 全部文本色对 `--void` / `--surface-1` 对比度 ≥ 4.5:1（微标签由 3.7:1 提升到 5.3:1）
- [x] 涨跌色符合中国习惯（涨红 `#FF5D6C` / 跌绿 `#2BE38A`）
- [x] 单一强调色 + 单一 AI 辅色，未引入第三组装饰色
- [x] 所有交互元素有 hover / focus-visible / disabled 三态
- [x] 画布高度由 `1fr` 自适应，无 `calc(100vh - 固定值)` 魔数
- [x] `prefers-reduced-motion` 降级
- [x] 装饰层 `aria-hidden` + `pointer-events:none`
- [x] 未重命名任何被 JS / 测试引用的类名或 id
- [x] `.ai-ghost` 保持不透明背景
- [x] 原生 `<option>` 保持深底浅字
