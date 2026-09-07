#!/usr/bin/env node
"use strict";

// 本地定制：让 `npm run start -- --ssh user@host[:/path] [--pass 密码]` 与 pi CLI 心智一致
// 摘出 --ssh 目标（注入 PI_WEB_SSH）与 --pass 密码（注入 PI_WEB_SSH_PASSWORD），
// 其余参数原样透传给上游 bin/pi-web.js；放在 bin/zmhuanf/ 命名空间内，保证与上游合并零冲突

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
const SSH_ENV = "PI_WEB_SSH";
const PASS_ENV = "PI_WEB_SSH_PASSWORD";

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
    rest.push(arg);
  }
  return { ssh, pass, rest };
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
    home && require("node:path").join(home, "bin", "plink.exe"),
    home && require("node:path").join(home, "scoop", "shims", "plink.exe"),
    home && require("node:path").join(home, "scoop", "apps", "putty", "current", "plink.exe"),
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
let rest;
try {
  ({ ssh, pass, rest } = parseSshArgs(process.argv.slice(2)));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
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