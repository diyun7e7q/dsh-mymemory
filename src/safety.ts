export class MemoryError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export function fail(code: string): never { throw new MemoryError(code); }
export function text(value: unknown, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail('INVALID_TEXT');
  return value.trim();
}
export function sensitive(value: string): boolean {
  return /(?:api[_ -]?key|password|passwd|密码|secret|access[_ -]?token|session[_ -]?token|authorization)\s*[:=：]\s*\S+|\b(?:sk-|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|Bearer\s+[\w.\-]{8,}/i.test(value);
}
export function suspicious(value: string): boolean {
  return /ignore.{0,30}(?:instructions|rules)|忽略.{0,20}(?:规则|指令)|泄露|exfiltrat|system\s*prompt|<\/?(?:system|memory)|运行命令|执行命令/i.test(value);
}
export function uncertain(value: string): boolean {
  // 只认真正的推测语气。以前／曾经／过去 是时间词，出现在确定事实里（"以前的仓库在…"），
  // 把它们当不确定会让正常记忆静默降级成 pending，而 pending 又搜不到。
  return /可能|也许|或许|maybe|might|probably|perhaps/i.test(value);
}
export function safeError(error: unknown): string {
  return error instanceof MemoryError ? error.code : 'STORAGE_OR_RUNTIME_ERROR';
}

/**
 * 常驻三类的准入：只收"下个对话仍然成立"的陈述。
 *
 * 模型很爱把项目进度写成 profile（"正在改 mymemory 的注入段"），一旦混进常驻块，
 * 每个对话都会带着一句昨天就过期的话。这里用形态判断兜住：带路径、日期、任务态的句子
 * 本质是进度记录，降级成 project —— 记着，但不带入。判断对用户不可见。
 */
export function longTermShape(value: string): boolean {
  const c = (value ?? '').trim();
  if (c.length > 120) return false;                                   // 长句多半是交代背景
  if (/[A-Za-z]:[\/]|(?:^|[\s(])\/(?:mnt|home|usr|etc|opt)\//.test(c)) return false;  // 路径
  if (/\b20\d{2}[-/年]\d{1,2}|20\d{2}年|\d{1,2}月\d{1,2}日|今天|明天|昨天|下周|上周|本月|刚才/.test(c)) return false;
  if (/正在|在做|还没|尚未|下一步|待办|TODO|进度|目前|暂时|先这样|刚刚/i.test(c)) return false;
  return true;
}
