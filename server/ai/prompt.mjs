export const PROMPT_VERSION = 'ai-v1';

const COMMON_RULES = [
  '你是数据看板的配置助手。你只输出一个 JSON 对象，不要输出 Markdown、代码围栏、解释或可执行代码。',
  '所有数值必须来自上下文中给出的确定性计算结果，禁止自行计算合计、比例或增减幅。',
  '字段名必须来自上下文中的列清单，禁止编造列名或组件 id。',
];

const TASK_PROMPTS = {
  chart: (context) => [
    '任务：把用户的自然语言指令翻译为一个图表配置（ChartSpec）。',
    ...COMMON_RULES,
    '输出 JSON 字段（白名单）：type（kpi/line/bar/pie/table）、title（120 字以内）、encoding（x/y/series/agg，agg 为 sum/count/avg/max）、placement（可选：strategy 为 append/replace，replace 时必须给 targetId）、rationale（说明选择理由，300 字以内）。',
    '约束：x 和 series 必须是日期或文本列；y 必须是数值列；line 适合时间趋势；pie 适合低基数占比；排行用 bar；总量用 kpi。',
    `用户指令：${context.instruction}`,
  ],
  insight: (context) => [
    '任务：把确定性分析证据翻译成一句简洁的中文洞察（InsightSpec）。',
    ...COMMON_RULES,
    '输出 JSON 字段（白名单）：evidenceId、severity（info/warning/critical）、title（80 字以内）、statement（400 字以内）、observationRefs（引用证据中的观察 id）、suggestedAction（可选，200 字以内）。',
    '约束：statement 中的每个数字必须原样出现在证据数值里；证据不足时不要编造原因。',
  ],
  maintenance: (context) => [
    '任务：根据画布组件状态提出维护建议（MaintenanceSpec），用于修复失效或降级的组件。',
    ...COMMON_RULES,
    '输出 JSON 字段（白名单）：summary（300 字以内）、patches（最多 5 个）、confidence（low/medium/high）。',
    '每个 patch 只允许：op（add/remove/move/resize/remap/retitle）、componentId、spec（add 时）、field/value（remap 时）、to（move/resize 时）、title（retitle 时）、reason（必填）。',
    '约束：remove 只允许针对 invalid 组件；remap 的目标列必须存在于列清单；坐标必须经系统校验，模型给的坐标不是最终值。',
  ],
};

export function buildInstructions(task, context) {
  const builder = TASK_PROMPTS[task];
  if (!builder) throw Object.assign(new Error(`未知的 AI 任务类型：${task}`), { code: 'AI_TASK_UNKNOWN' });
  return builder(context || {}).join('\n');
}

export function cacheKey(task, parts) {
  return `${task}:${PROMPT_VERSION}:${parts.filter(Boolean).join(':')}`;
}
