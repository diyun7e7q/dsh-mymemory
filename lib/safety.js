export class MemoryError extends Error {
  code        ;
  constructor(code        ) { super(code); this.code = code; }
}
export function fail(code        )        { throw new MemoryError(code); }
export function text(value         , max = 2000)         {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail('INVALID_TEXT');
  return value.trim();
}
export function sensitive(value        )          {
  return /(?:api[_ -]?key|password|passwd|密码|secret|access[_ -]?token|session[_ -]?token|authorization)\s*[:=：]\s*\S+|\b(?:sk-|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|Bearer\s+[\w.\-]{8,}/i.test(value);
}
export function suspicious(value        )          {
  return /ignore.{0,30}(?:instructions|rules)|忽略.{0,20}(?:规则|指令)|泄露|exfiltrat|system\s*prompt|<\/?(?:system|memory)|运行命令|执行命令/i.test(value);
}
export function uncertain(value        )          {
  // 只认真正的推测语气。以前／曾经／过去 是时间词，出现在确定事实里（"以前的仓库在…"），
  // 把它们当不确定会让正常记忆静默降级成 pending，而 pending 又搜不到。
  return /可能|也许|或许|maybe|might|probably|perhaps/i.test(value);
}
export function safeError(error         )         {
  return error instanceof MemoryError ? error.code : 'STORAGE_OR_RUNTIME_ERROR';
}
