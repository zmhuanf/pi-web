#!/usr/bin/env node
"use strict";

// 本地定制：让 `npm run start -- --ssh user@host[:/path] [--pass 密码] [--proxy 地址] [--ps|--bash]` 与 pi CLI 心智一致
// 摘出本地参数注入环境变量，其余参数原样透传给上游 bin/pi-web.js
// 放在 bin/zmhuanf/ 命名空间内，保证与上游合并零冲突

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn, spawnSync } = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { wireChildProcessLifecycle } = require("../process-lifecycle");

const SSH_FLAG = "--ssh";
const PASS_FLAG = "--pass";
const PROXY_FLAG = "--proxy";
const PS_FLAG = "--ps";
const BASH_FLAG = "--bash";
const SSH_ENV = "PI_WEB_SSH";
const PASS_ENV = "PI_WEB_SSH_PASSWORD";
const SHELL_ENV = "PI_WEB_SSH_SHELL";

function flagValue(flag, args, index) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(
      flag === SSH_FLAG
        ? `${flag} requires a value, e.g. ${flag} user@host:/remote/path`
        : `${flag} requires a value`,
    );
  }
  return value;
}

function parseSshArgs(args) {
  const rest = [];
  let ssh;
  let pass;
  let proxy;
  let shell;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === SSH_FLAG) {
      ssh = flagValue(SSH_FLAG, args, i);
      i += 1;
      continue;
    }
    if (arg.startsWith(`${SSH_FLAG}=`)) {
      const value = arg.slice(SSH_FLAG.length + 1);
      if (!value) {
        throw new Error(
          `${SSH_FLAG} requires a value, e.g. ${SSH_FLAG}=user@host:/remote/path`,
        );
      }
      ssh = value;
      continue;
    }
    if (arg === PASS_FLAG) {
      pass = flagValue(PASS_FLAG, args, i);
      i += 1;
      continue;
    }
    if (arg.startsWith(`${PASS_FLAG}=`)) {
      const value = arg.slice(PASS_FLAG.length + 1);
      if (!value) {
        throw new Error(`${PASS_FLAG} requires a value`);
      }
      pass = value;
      continue;
    }
    if (arg === PROXY_FLAG) {
      proxy = flagValue(PROXY_FLAG, args, i);
      i += 1;
      continue;
    }
    if (arg.startsWith(`${PROXY_FLAG}=`)) {
      const value = arg.slice(PROXY_FLAG.length + 1);
      if (!value) {
        throw new Error(`${PROXY_FLAG} requires a value`);
      }
      proxy = value;
      continue;
    }
    if (arg === PS_FLAG || arg === BASH_FLAG) {
      const next = arg === PS_FLAG ? "powershell" : "bash";
      if (shell !== undefined && shell !== next) {
        throw new Error(`${PS_FLAG} 与 ${BASH_FLAG} 不能同时使用`);
      }
      shell = next;
      continue;
    }
    rest.push(arg);
  }
  return { ssh, pass, proxy, shell, rest };
}

function fail(message) {
  fs.writeSync(process.stderr.fd, `${message}\n`);
  process.exit(1);
}

// 密码模式依赖 plink.exe，启动时预检避免运行时才暴露
function findPlink() {
  const home = process.env.USERPROFILE || process.env.HOME;
  const candidates = [
    process.env.PLINK,
    home && path.join(home, "bin", "plink.exe"),
    home && path.join(home, "scoop", "shims", "plink.exe"),
    home && path.join(home, "scoop", "apps", "putty", "current", "plink.exe"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const r = spawnSync("where", ["plink"], { encoding: "utf8" });
    const first = r.stdout ? r.stdout.split(/\r?\n/)[0].trim() : "";
    if (first && fs.existsSync(first)) return first;
  } catch {
    // ignore
  }
  return undefined;
}

let ssh;
let pass;
let proxy;
let shell;
let rest;
try {
  ({ ssh, pass, proxy, shell, rest } = parseSshArgs(process.argv.slice(2)));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (shell && !ssh) {
  fail(`${shell === "powershell" ? PS_FLAG : BASH_FLAG} 需要与 ${SSH_FLAG} 一起使用`);
}

if (pass) {
  const plink = findPlink();
  if (!plink) {
    fail(
      "密码模式需要 plink.exe：请执行 scoop install putty 或 winget install PuTTY.PuTTY，" +
        "或下载 plink.exe 放入 PATH 后重试",
    );
  }
  console.log(`[pi-web] plink: ${plink}`);
}

const piWebBin = path.join(__dirname, "..", "pi-web.js");
const child = spawn(process.execPath, [piWebBin, ...rest], {
  cwd: path.join(__dirname, "..", ".."),
  stdio: "inherit",
  env: {
    ...process.env,
    ...(ssh ? { [SSH_ENV]: ssh } : {}),
    ...(pass ? { [PASS_ENV]: pass } : {}),
    ...(shell ? { [SHELL_ENV]: shell } : {}),
    ...(proxy ? {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
    } : {}),
  },
});
wireChildProcessLifecycle(child);

if (ssh) {
  // 提示生效目标，便于确认 SSH 模式已激活（ssh.ts 在 session_start 读 PI_WEB_SSH）
  console.log(`[pi-web] SSH mode: ${ssh}`);
}
if (pass) {
  // 提示密码认证已激活（ssh.ts 经 plink -pw 用 PI_WEB_SSH_PASSWORD）
  console.log("[pi-web] SSH password auth enabled (PI_WEB_SSH_PASSWORD)");
}
if (shell) {
  // 提示远端执行方式（ssh.ts 读 PI_WEB_SSH_SHELL 决定 bash 还是 PowerShell）
  console.log(`[pi-web] SSH remote shell: ${shell}`);
}
if (proxy) {
  console.log("[pi-web] HTTP proxy enabled");
}
