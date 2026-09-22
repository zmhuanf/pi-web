// SSH 远程模式判定，供上游 resolveShellTools 强制 bash 用（远端只有 bash，且内置 powershell 会绕过 ssh 扩展打本机）

export function isSshSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.PI_WEB_SSH);
}
