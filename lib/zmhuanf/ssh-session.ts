// SSH 远程模式判定，供上游 resolveShellTools 决定用哪个 shell 工具：
// 远端只有 bash 时内置 powershell 工具会绕过 ssh 扩展打本机，故默认强制 bash；
// 远端是 Windows（启动参数 --ps）时改用 powershell 工具，远端实现由 ssh 扩展提供

export const SSH_SHELL_ENV = "PI_WEB_SSH_SHELL";

export function isSshSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.PI_WEB_SSH);
}

/** --ps 指定的远端是 Windows，SSH 会话改用 powershell 工具名 */
export function isSshPowerShell(env: NodeJS.ProcessEnv = process.env): boolean {
  return isSshSession(env) && env[SSH_SHELL_ENV] === "powershell";
}