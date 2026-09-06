#!/usr/bin/env node
"use strict";

// 本地定制：让 `npm run start -- --ssh user@host[:/path]` 与 pi CLI 心智一致
// 摘出 --ssh 目标并注入 PI_WEB_SSH 环境变量，其余参数原样透传给上游 bin/pi-web.js
// 放在 bin/zmhuanf/ 命名空间内，保证与上游合并零冲突

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { wireChildProcessLifecycle } = require("../process-lifecycle");

const SSH_FLAG = "--ssh";
const SSH_ENV = "PI_WEB_SSH";

function parseSshArgs(args) {
  const rest = [];
  let ssh;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === SSH_FLAG) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(
          `${SSH_FLAG} requires a value, e.g. ${SSH_FLAG} user@host:/remote/path`,
        );
      }
      ssh = value;
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
    rest.push(arg);
  }
  return { ssh, rest };
}

function fail(message) {
  fs.writeSync(process.stderr.fd, `${message}\n`);
  process.exit(1);
}

let ssh;
let rest;
try {
  ({ ssh, rest } = parseSshArgs(process.argv.slice(2)));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const piWebBin = path.join(__dirname, "..", "pi-web.js");
const child = spawn(process.execPath, [piWebBin, ...rest], {
  cwd: path.join(__dirname, "..", ".."),
  stdio: "inherit",
  env: {
    ...process.env,
    ...(ssh ? { [SSH_ENV]: ssh } : {}),
  },
});
wireChildProcessLifecycle(child);

if (ssh) {
  // 提示生效目标，便于确认 SSH 模式已激活（ssh.ts 在 session_start 读 PI_WEB_SSH）
  console.log(`[pi-web] SSH mode: ${ssh}`);
}