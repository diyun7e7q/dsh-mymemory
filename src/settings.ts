/**
 * 宿主设置页的字段声明。
 *
 * DSH 从包主入口的 `Config` 导出读这份描述，在插件配置页渲染成表单；
 * 用户改完、保存，这一行重新挂载，改动进 `apply(ctx, config)`。
 *
 * 为什么自己写 descriptor 而不引 schemastery：`@deepseek-ai/dsh-settings`
 * 的接口在 0.1.0-rc.7 → 0.1.2-alpha.1 → 0.1.7 之间换过三次（命名导出被删、
 * `register` 被 `describe`+`update` 取代）。只有 `~standard` 这一层是稳的——
 * 它属于 Standard Schema 约定，宿主拿它做校验，不关心我们内部长什么样。
 * 少一个依赖，就少一处跟着上游漂移的地方。
 *
 * 字段只暴露"改了有意义、且用户在面板上改得动"的那几个。注入顺序、
 * 分词规则、pending 判定这些属于实现，写进面板只会制造假的自由度。
 */

/**
 * @param {{type:string,meta?:object,inner?:object,dict?:object}} field
 * @returns {object} 宿主可序列化的字段描述
 */
import {validateBudgets} from './config.ts';
type Field={type:string;meta?:Record<string,unknown>;inner?:Field;dict?:Record<string,Field>};
function descriptor(field:Field):any {
  return {
    type: field.type,
    meta: { ...field.meta },
    ...(field.inner ? { inner: descriptor(field.inner) } : {}),
    ...(field.dict
      ? { dict: Object.fromEntries(Object.entries(field.dict).map(([key, value]) => [key, descriptor(value)])) }
      : {}),
    // 宿主会剥掉易变元数据再复制一份做校验，返回脱离的树免得连累后续描述。
    toJSON() {
      return JSON.parse(JSON.stringify({ ...this, toJSON: undefined }));
    },
  };
}

/**
 * @param {string} type 宿主支持的控件类型
 * @param {string} description 面板上显示给人看的那句话
 */
const editable = (type:string, description:string) => ({ type, meta: { volatile: true, description } });

/**
 * 组装一个 Standard Schema：`~standard.validate` 是宿主唯一的入口。
 *
 * @param {(value:unknown)=>object} normalize 把面板值收敛成 apply 吃的形状
 * @param {Record<string,object>} fields 顶层字段
 */
function settingsConfig(normalize:(value:unknown)=>any, fields:Record<string,Field>) {
  return Object.assign(descriptor({ type: 'object', dict: fields }), {
    '~standard': {
      version: 1,
      vendor: 'dsh-mymemory',
      validate(value:unknown) {
        try {
          return { value: normalize(value) };
        } catch (error) {
          return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
        }
      },
    },
  });
}

/** 面板暴露的预算键。其余预算（队列、超时、日限额）属于调优，留在 CLI/DB。 */
const BUDGET_KEYS = ['coreBudget', 'retrievalBudget', 'profileBudgetChars', 'maxMemoryChars', 'maxResults'];
const AUTO_MODES = ['off', 'candidates', 'conservative'];

function optionalText(value:unknown, key:string) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * 面板值 → apply 的 config。
 *
 * 只保留出现过的键：没写不等于"关掉"，否则每次保存都会把用户没碰的
 * 预算清回默认值。
 *
 * @param {unknown} value
 */
export function normalizeConfig(value:unknown) {
  const raw:Record<string,unknown> = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
  const out:{dataDir?:string;soulPath?:string;autoMode?:string;budgets?:Record<string,number>;extractionProvider?:string;extractionModel?:string} = {};
  const dataDir = optionalText(raw.dataDir, 'dataDir');
  if (dataDir) out.dataDir = dataDir;
  const soulPath = optionalText(raw.soulPath, 'soulPath');
  if (soulPath) out.soulPath = soulPath;
  if (raw.autoMode !== undefined && raw.autoMode !== null && raw.autoMode !== '') {
    if (typeof raw.autoMode!=='string'||!AUTO_MODES.includes(raw.autoMode)) throw new Error(`autoMode 只能是 ${AUTO_MODES.join(' / ')}`);
    out.autoMode = raw.autoMode;
  }
  // 后台整理单独走模型：它每轮对话都可能触发，跟着会话主模型跑等于把成本乘上工具轮数。
  const extractionProvider = optionalText(raw.extractionProvider, 'extractionProvider');
  if (extractionProvider) out.extractionProvider = extractionProvider;
  const extractionModel = optionalText(raw.extractionModel, 'extractionModel');
  if (extractionModel) out.extractionModel = extractionModel;
  const budgets:Record<string,number> = {};
  for (const key of BUDGET_KEYS) {
    const raw_ = raw[key];
    if (raw_ === undefined || raw_ === null || raw_ === '') continue;
    const n = Number(raw_);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${key} 必须是非负整数`);
    budgets[key] = n;
  }
  if (Object.keys(budgets).length) {validateBudgets(budgets);out.budgets = budgets;}
  return out;
}

/** 插件配置页的表单描述。 */
export const Config = settingsConfig(normalizeConfig, {
  dataDir: editable('string', '记忆库目录，SQLite 与 SOUL.md 都放这里。改它等于换一个库，重启后生效。'),
  soulPath: editable('string', '人格文件所在目录，读其中的 SOUL.md。留空用 dataDir。'),
  autoMode: editable('string', '自动记忆：off 关闭；candidates 自动整理，抽到的先搁置；conservative 你说「记住」的当场生效。'),
  coreBudget: editable('number', '常驻记忆预算（UTF-8 字节，0–2048）。身份、约束、偏好每轮都带上，超了挤掉靠后的。0 = 不注入。'),
  retrievalBudget: editable('number', '检索结果注入预算（UTF-8 字节）。'),
  maxResults: editable('number', '单次检索最多返回条数，1–20。'),
  maxMemoryChars: editable('number', '单条记忆最大字符数，16–2000。'),
  extractionProvider: editable('string', '后台整理调用的模型提供方。留空跟随当前会话模型。'),
  extractionModel: editable('string', '后台整理调用的模型，建议填低价 Flash 档。留空跟随当前会话模型。'),
});
