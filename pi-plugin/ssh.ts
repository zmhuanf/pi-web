/**
 * SSH Remote Execution Example
 *
 * Demonstrates delegating tool operations to a remote machine via SSH.
 * When --ssh is provided, read/write/edit/bash run on the remote.
 *
 * Usage:
 *   pi -e ./ssh.ts --ssh user@host
 *   pi -e ./ssh.ts --ssh user@host:/remote/path
 *   pi -e ./ssh.ts --ssh user@host:2222   (非默认 SSH 端口)
 *   npm run start -- --ssh user@host[:/remote/path|:<port>]  (pi-web 注入 PI_WEB_SSH)
 *   npm run start -- --ssh user@host:/path --pass xxx  (密码经 plink -pw)
 *   npm run start -- --ssh user@host --ps   (远端是 Windows，整套远端操作走 PowerShell)
 *   npm run start -- --ssh user@host --bash (显式指定 bash，等于默认；注入 PI_WEB_SSH_SHELL)
 *
 * Requirements:
 *   - key 认证走原生 ssh；密码认证需 plink（scoop install putty）
 *   - 密码认证经常驻 plink -share 连接复用，避免每次命令重新握手
 *   - bash 模式要求远端有 bash 与 coreutils（rg/grep/find/cat）
 *   - PowerShell 模式（--ps）要求远端有 Windows PowerShell 5.1，文件读写走 base64 直传字节
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLocalBashOperations,
	createLocalPowerShellOperations,
	createLsTool,
	createPowerShellTool,
	createReadTool,
	createWriteTool,
	generateDiffString,
	generateUnifiedPatch,
	type EditOperations,
	type FindOperations,
	type LsOperations,
	type ReadOperations,
	type WriteOperations,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

// 冒号后纯数字视为端口（如 host:2222），跨会话可被 buildSshInvocation 读取
let sshPort: string | undefined;

// 远端执行方式：--ps 的远端是 Windows，PowerShell 是它唯一可用的 shell
type RemoteShell = "bash" | "powershell";
let remoteShell: RemoteShell = "bash";

function isPowerShellRemote(): boolean {
	return remoteShell === "powershell";
}

// PowerShell 脚本统一前缀：UTF-8 输出，抑制进度流（进度会以 CLIXML 混进 stderr）
const PS_PREFIX = "$ProgressPreference='SilentlyContinue'\n$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.Encoding]::UTF8\n";

// PowerShell 单引号字面量，内部单引号翻倍
function psQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

// 远端脚本包装：bash 直发，PowerShell 走 UTF-16LE base64，免引号转义且远端默认 shell 是 cmd 也照跑
function remoteScript(script: string): string {
	if (!isPowerShellRemote()) return script;
	// 必须套 try/catch：PS 5.1 会把未捕获的报错以 CLIXML 序列化到 stderr，模型只能看到垃圾
	const body = `${PS_PREFIX}try {\n${script}\n} catch {\n[Console]::Error.WriteLine($_.Exception.Message)\nexit 1\n}`;
	const encoded = Buffer.from(body, "utf16le").toString("base64");
	return `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

// Windows 远端路径统一为正斜杠形式，各工具与本地正则都以 / 为准
function normalizeRemotePath(value: string): string {
	return value.replaceAll("\\", "/").replace(/\/+$/, "");
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

export interface SshTarget {
	remote: string;
	remoteCwd: string;
	remoteHome: string;
}
// sshpass/askpass 在本机均无法喂密码（详见排查），密码认证改用 plink -pw
// 首次连接自动提取指纹并缓存，plink -hostkey 可免交互信任
const HOSTKEY_STORE = path.join(os.tmpdir(), "pi-web-ssh-hostkeys.json");

function storedHostKey(remote: string): string | undefined {
	try {
		const store = JSON.parse(fs.readFileSync(HOSTKEY_STORE, "utf8"));
		return store[`${remote}:${sshPort ?? "22"}`];
	} catch {
		return undefined;
	}
}

function saveHostKey(remote: string, fingerprint: string): void {
	let store: Record<string, string> = {};
	try {
		store = JSON.parse(fs.readFileSync(HOSTKEY_STORE, "utf8"));
	} catch {
		// 缓存损坏时重建
	}
	store[`${remote}:${sshPort ?? "22"}`] = fingerprint;
	try {
		fs.writeFileSync(HOSTKEY_STORE, JSON.stringify(store), "utf8");
	} catch {
		// 写失败仅影响下次自动重试，不影响本次连接
	}
}

// 从 plink 错误输出提取 host key 指纹（ssh-ed25519 255 SHA256:xxxx）
function extractFingerprint(stderr: string): string | undefined {
	const m = stderr.match(/SHA256:[A-Za-z0-9+/=]+/);
	return m?.[0];
}

// 无密码的 key 认证走原生 ssh
function buildSshInvocation(remote: string, command: string): { bin: string; args: string[]; env: NodeJS.ProcessEnv } {
	// accept-new 免首次连接 host key 确认（stdin 被 ignore 无法交互）
	const sshArgs = ["-o", "StrictHostKeyChecking=accept-new", ...(sshPort ? ["-p", sshPort] : []), remote, command];
	return { bin: "ssh", args: sshArgs, env: process.env };
}

// 写文件的 stdin 传输超时（秒）：plink 偶发不送 stdin EOF，远端会永久阻塞，只能靠超时兜底
const STDIN_TIMEOUT_SEC = 15;

// 带 stdin 的调用超时后换成能看懂的报错，其余错误原样抛出
function asStdinTimeout(error: unknown, timeout: number | undefined): unknown {
	const message = error instanceof Error ? error.message : String(error);
	return timeout !== undefined && message === `timeout:${timeout}`
		? new Error(`远端 ${timeout}s 内没读完 stdin（plink 未正常关闭输入），已中止，可重试本次写入`)
		: error;
}

// 无密码时走原生 ssh（key 认证），有密码时走 plink -pw
function execShell(remote: string, script: string, input?: Buffer): Promise<Buffer> {
	const command = remoteScript(script);
	const pass = process.env.PI_WEB_SSH_PASSWORD;
	const timeout = input ? STDIN_TIMEOUT_SEC : undefined;
	if (!pass) {
		return sshOutput(remote, command, input, timeout).catch((error) => {
			throw asStdinTimeout(error, timeout);
		});
	}
	return plinkOutput(remote, command, input ? { input, timeout } : {})
		.then((r) => {
			if (r.code !== 0) {
				const stderr = r.stderr.trim();
				// plink 失败时原因可能在 stdout，两者都带上才能定位
				throw new Error(`SSH failed (${r.code}): ${stderr || r.stdout.toString().trim()}`);
			}
			return r.stdout;
		})
		.catch((error) => {
			throw asStdinTimeout(error, timeout);
		});
}

function sshOutput(remote: string, command: string, input?: Buffer, timeout?: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const { bin, args, env } = buildSshInvocation(remote, command);
		// 内容走 stdin：大文件当命令行参数会撑爆 Windows 上限（spawn ENAMETOOLONG）
		const child = spawn(bin, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"], env });
		let timedOut = false;
		const timer = timeout
			? setTimeout(() => {
					timedOut = true;
					child.kill();
				}, timeout * 1000)
			: undefined;
		if (input) {
			// ssh 提前退出时写 stdin 会抛 EPIPE，吞掉即可由 close 分支报错
			child.stdin.on("error", () => {});
			child.stdin.end(input);
		}
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (data) => chunks.push(data));
		child.stderr.on("data", (data) => errChunks.push(data));
		child.on("error", (error) => {
			if (timer) clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			if (timedOut) {
				reject(new Error(`timeout:${timeout}`));
			} else if (code !== 0) {
				const stderr = Buffer.concat(errChunks).toString().trim();
				// ssh 的部分失败原因只出现在 stdout，两者都带上才能定位
				const stdout = Buffer.concat(chunks).toString().trim();
				reject(new Error(`SSH failed (${code}): ${stderr || stdout}`));
			} else {
				resolve(Buffer.concat(chunks));
			}
		});
	});
}

interface PlinkRunOptions {
	onData?: (chunk: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
	/** 写入远端命令 stdin 的内容 */
	input?: Buffer;
}

interface PlinkResult {
	code: number | null;
	stdout: Buffer;
	stderr: string;
}

// 定位 plink 绝对路径（PATH 缺失时也可用），避免 spawn 失败难排查
let plinkBin: string | undefined;
function resolvePlink(): string | undefined {
	if (plinkBin) return plinkBin;
	const home = os.homedir();
	const candidates = [
		process.env.PLINK,
		path.join(home, "bin", "plink.exe"),
		path.join(home, "scoop", "shims", "plink.exe"),
		path.join(home, "scoop", "apps", "putty", "current", "plink.exe"),
	];
	for (const c of candidates) {
		if (c && fs.existsSync(c)) {
			plinkBin = c;
			return c;
		}
	}
	try {
		const r = spawnSync("where", ["plink"], { encoding: "utf8" });
		const first = r.stdout.split(/\r?\n/)[0]?.trim();
		if (first && fs.existsSync(first)) {
			plinkBin = first;
			return first;
		}
	} catch {
		// where 不可用时回退 null，错误信息会给出安装指引
	}
	return undefined;
}

// 密码认证无法用原生 ssh 的 ControlMaster，改用 plink -share 复用已认证连接
const UPSTREAM_IDLE_MS = 10 * 60 * 1000;
let upstream: { remote: string; child: ChildProcess } | null = null;
let upstreamIdleTimer: NodeJS.Timeout | undefined;

// 常驻上游：上游自身必须带 -share，否则后续连接无法复用
function startUpstream(remote: string): void {
	const bin = resolvePlink();
	const fingerprint = storedHostKey(remote);
	if (!bin || !fingerprint) return;
	const args = ["-share", "-ssh", "-batch"];
	if (sshPort) args.push("-P", sshPort);
	args.push("-pw", process.env.PI_WEB_SSH_PASSWORD ?? "", "-hostkey", fingerprint, remote, "cat");
	// stdin 保持打开且不 end，远端 cat 阻塞即保持连接；Node 退出时管道关闭自动收盘
	const child = spawn(bin, args, { stdio: ["pipe", "ignore", "ignore"] });
	child.unref();
	child.on("exit", () => {
		if (upstream?.child === child) upstream = null;
	});
	child.on("error", () => {
		if (upstream?.child === child) upstream = null;
	});
	upstream = { remote, child };
}

function stopUpstream(): void {
	if (upstreamIdleTimer) {
		clearTimeout(upstreamIdleTimer);
		upstreamIdleTimer = undefined;
	}
	const child = upstream?.child;
	upstream = null;
	child?.kill();
}

// 确保上游存在并刷新空闲计时；无上游时 -share 自动回退为新建连接，不影响正确性
function touchUpstream(remote: string): void {
	if (!upstream || upstream.remote !== remote || upstream.child.exitCode !== null || upstream.child.killed) {
		stopUpstream();
		startUpstream(remote);
	}
	if (upstreamIdleTimer) clearTimeout(upstreamIdleTimer);
	upstreamIdleTimer = setTimeout(stopUpstream, UPSTREAM_IDLE_MS);
	upstreamIdleTimer.unref();
}

// 单次 spawn plink；指纹缺失时首次连接会因 hostkey 未缓存而失败
function spawnPlink(remote: string, command: string, options: PlinkRunOptions, fingerprint: string | undefined): Promise<PlinkResult> {
	return new Promise((resolve, reject) => {
		const bin = resolvePlink();
		if (!bin) {
			reject(new Error("未找到 plink：请 winget install PuTTY.PuTTY 或 scoop install putty，或下载 plink.exe 放入 PATH"));
			return;
		}
		touchUpstream(remote);
		const args = ["-share", "-ssh", "-batch"];
		if (sshPort) args.push("-P", sshPort);
		args.push("-pw", process.env.PI_WEB_SSH_PASSWORD ?? "");
		if (fingerprint) args.push("-hostkey", fingerprint);
		args.push(remote, command);
		const child = spawn(bin, args, { stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"] });
		if (options.input) {
			// plink 提前退出时写 stdin 会抛 EPIPE，吞掉即可由 close 分支报错
			child.stdin.on("error", () => {});
			child.stdin.end(options.input);
		}
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		let timedOut = false;
		const onData = options.onData;
		child.stdout.on("data", (d) => {
			chunks.push(d);
			onData?.(d);
		});
		child.stderr.on("data", (d) => {
			// stderr 同样并入输出，否则根本看不到命令失败的原因
			errChunks.push(d);
			onData?.(d);
		});
		const timer = options.timeout
			? setTimeout(() => {
					timedOut = true;
					child.kill();
				}, options.timeout * 1000)
			: undefined;
		child.on("error", (e) => {
			if (timer) clearTimeout(timer);
			reject(new Error(`plink 启动失败（${e.message}），请确认已安装 plink`));
		});
		const onAbort = () => child.kill();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (options.signal?.aborted) reject(new Error("aborted"));
			else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
			else resolve({ code, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errChunks).toString() });
		});
	});
}

// plink 执行；hostkey 未缓存时提取指纹自动信任并重试一次再到缓存文件
function plinkOutput(remote: string, command: string, options: PlinkRunOptions = {}): Promise<PlinkResult> {
	return spawnPlink(remote, command, options, storedHostKey(remote)).then(async (result) => {
		if (result.code === 0 || result.code === undefined || storedHostKey(remote)) return result;
		const fingerprint = extractFingerprint(result.stderr);
		if (!fingerprint) return result;
		saveHostKey(remote, fingerprint);
		// 提前建立常驻连接，本次后续调用即可复用
		startUpstream(remote);
		return spawnPlink(remote, command, options, fingerprint);
	});
}

// Windows 路径大小写不敏感，比较时统一折叠
function foldCase(value: string): string {
	return process.platform === "win32" ? value.toLowerCase() : value;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** glob 转 GNU find 扩展正则：** 跨层，* ? 仅限单层；find 的 -regex 匹配从搜索根开始的完整路径 */
function globToFindRegex(glob: string, searchRoot: string): string {
	const segments = glob.replaceAll("\\", "/").split("/").filter((segment) => segment !== "" && segment !== ".");
	const body = segments
		.map((segment, index) => {
			if (segment === "**") return index === segments.length - 1 ? ".*" : "(.*/)?";
			const literal = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*").replaceAll("?", "[^/]");
			return `${literal}/`;
		})
		.join("");
	const root = searchRoot.replaceAll("\\", "/").replace(/\/+$/, "");
	const prefix = root === "" ? "/" : `${escapeRegExp(root)}/`;
	return `^${prefix}${body.replace(/\/$/, "")}$`;
}

/** 文案里的本地镜像路径还原为远程路径，命名空间外的本地路径保持原样 */
function restoreRemoteText(text: string, localCwd: string, ssh: SshTarget): string {
	const absolute = new RegExp(`${escapeRegExp(localCwd)}[^\\s"'\`()]*`, "gi");
	// 工具回显的可能是不带本地前缀的镜像相对路径
	const relative = new RegExp(`(?:${escapeRegExp(SSH_NAMESPACE)}/[^\\s"'\`()]*)`, "g");
	return text
		.replace(absolute, (match) => {
			try {
				return toRemotePath(match, localCwd, ssh.remoteCwd);
			} catch {
				return match;
			}
		})
		.replace(relative, (match) => mirrorRelativeToRemote(match.slice(SSH_NAMESPACE.length + 1)));
}

/** SSH 模式下统一还原返回内容与错误信息中的路径显示 */
async function withRemotePaths<T>(localCwd: string, ssh: SshTarget, run: () => Promise<T>): Promise<T> {
	try {
		const result = (await run()) as {
			content?: { type: string; text?: string }[];
			details?: { diff?: string; patch?: string };
		};
		for (const block of result?.content ?? []) {
			if (block.type === "text" && block.text) block.text = restoreRemoteText(block.text, localCwd, ssh);
		}
		if (result?.details?.diff) result.details.diff = restoreRemoteText(result.details.diff, localCwd, ssh);
		if (result?.details?.patch) result.details.patch = restoreRemoteText(result.details.patch, localCwd, ssh);
		return result as T;
	} catch (error) {
		throw new Error(restoreRemoteText(error instanceof Error ? error.message : String(error), localCwd, ssh));
	}
}

// 目标相对工作区的片段，null 表示落在工作区外
function relativeWithin(target: string, root: string): string | null {
	const normalizedTarget = target.replaceAll("\\", "/");
	const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
	if (normalizedRoot === "/") return foldCase(normalizedTarget) === "/" ? "" : normalizedTarget.replace(/^\/+/, "");
	if (foldCase(normalizedTarget) === foldCase(normalizedRoot)) return "";
	if (foldCase(normalizedTarget).startsWith(`${foldCase(normalizedRoot)}/`)) {
		return normalizedTarget.slice(normalizedRoot.length + 1);
	}
	return null;
}

// 远程根命名空间：镜像路径仅在本地下虚拟存在，从不写盘
const SSH_NAMESPACE = ".__pi_ssh__";

function stripTrailingSlash(value: string): string {
	return value.replaceAll("\\", "/").replace(/\/+$/, "");
}

function mirrorRoot(localCwd: string): string {
	return path.join(localCwd, SSH_NAMESPACE);
}

/** 远程路径换算为镜像相对段，Windows 盘符的冒号在本地镜像路径里非法，改为同名段 */
function mirrorRelative(remotePath: string): string {
	const relative = remotePath.replaceAll("\\", "/").replace(/^\/+/, "");
	return relative.replace(/^([A-Za-z]):(?=\/|$)/, "$1");
}

/** 镜像相对段还原为远程绝对路径，PowerShell 远端补回盘符冒号 */
function mirrorRelativeToRemote(relative: string): string {
	if (isPowerShellRemote()) {
		const drive = relative.match(/^([A-Za-z])(?=\/|$)/);
		if (drive) return `${drive[1]}:${relative.slice(1)}`;
	}
	return relative === "" ? "/" : `/${relative}`;
}

/** 远程绝对路径换算为本地镜像绝对路径，远程根对应命名空间根 */
export function remoteToMirror(remotePath: string, localCwd: string): string {
	const relative = mirrorRelative(remotePath);
	return relative === "" ? mirrorRoot(localCwd) : path.join(mirrorRoot(localCwd), ...relative.split("/"));
}

// SDK 解析后的镜像本地路径还原为远程绝对路径
function toRemotePath(filePath: string, localCwd: string, remoteCwd: string): string {
	// 会话 cwd 自身代表远程工作目录
	if (foldCase(stripTrailingSlash(filePath)) === foldCase(stripTrailingSlash(localCwd))) return remoteCwd;
	const relative = relativeWithin(filePath, mirrorRoot(localCwd));
	if (relative === null) throw new Error(`路径不在 SSH 命名空间内: ${filePath}`);
	return mirrorRelativeToRemote(relative);
}

function quoteRemoteArg(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** 模型给出的路径按远程语义解析为远程绝对路径，远程文件系统内任意路径均可访问 */
export function resolveRemotePath(input: string, localCwd: string, ssh: SshTarget): string {
	const normalized = input.replaceAll("\\", "/");
	// SDK 回传的镜像形式还原为远程路径
	const mirrored = relativeWithin(normalized, mirrorRoot(localCwd));
	if (mirrored !== null) return mirrorRelativeToRemote(mirrored);
	// Windows 远端：盘符绝对路径按远端语义原样保留
	if (isPowerShellRemote()) {
		if (normalized === "~") return ssh.remoteHome;
		if (normalized.startsWith("~/")) return path.posix.normalize(path.posix.join(ssh.remoteHome, normalized.slice(2)));
		if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/")) return path.posix.normalize(normalized);
		return path.posix.normalize(path.posix.join(ssh.remoteCwd, normalized));
	}
	if (process.platform === "win32" && /^[A-Za-z]:\//.test(normalized)) {
		throw new Error(`${input} 不是远程路径；远程可访问任意绝对路径（如 /etc/hosts）`);
	}
	if (normalized === "~") return ssh.remoteHome;
	if (normalized.startsWith("~/")) return path.posix.normalize(path.posix.join(ssh.remoteHome, normalized.slice(2)));
	if (normalized.startsWith("/")) return path.posix.normalize(normalized);
	return path.posix.normalize(path.posix.join(ssh.remoteCwd, normalized));
}

/** 模型路径折算为 sessionCwd 下的相对镜像路径，交给 SDK 工具自己的路径解析 */
export function toMirrorPath(input: string, localCwd: string, ssh: SshTarget): string {
	const mirror = remoteToMirror(resolveRemotePath(input, localCwd, ssh), localCwd);
	const relative = path.relative(localCwd, mirror);
	return relative === "" ? "." : relative.split(path.sep).join("/");
}

// 一次连接取回远端 cwd 与 $HOME，用于路径镜像
async function probeRemotePaths(remote: string): Promise<{ cwd: string; home: string }> {
	const script = isPowerShellRemote() ? "(Get-Location).Path; $HOME" : `pwd; printf '%s\n' "$HOME"`;
	const lines = (await execShell(remote, script))
		.toString()
		.split(/\r?\n/)
		.map((line) => (isPowerShellRemote() ? normalizeRemotePath(line) : line.trim()))
		.filter(Boolean);
	const cwd = lines[0] ?? "/";
	return { cwd, home: lines[1] ?? cwd };
}

async function remotePathExists(remote: string, remotePath: string): Promise<boolean> {
	if (isPowerShellRemote()) {
		const output = await execShell(remote, `Test-Path -LiteralPath ${psQuote(remotePath)}`);
		return output.toString().trim().toLowerCase() === "true";
	}
	const output = await execShell(
		remote,
		`if test -e ${quoteRemoteArg(remotePath)}; then printf 1; else printf 0; fi`,
	);
	return output.toString().trim() === "1";
}

// PowerShell 远端目录判定
async function remotePathIsDirectory(remote: string, remotePath: string): Promise<boolean> {
	const output = await execShell(remote, `(Get-Item -LiteralPath ${psQuote(remotePath)} -Force).PSIsContainer`);
	return output.toString().trim().toLowerCase() === "true";
}

async function resolveRemoteGrepTool(remote: string): Promise<"rg" | "grep"> {
	const output = await execShell(
		remote,
		"if command -v rg >/dev/null 2>&1; then printf rg; elif command -v grep >/dev/null 2>&1; then printf grep; else printf none; fi",
	);
	const tool = output.toString().trim();
	if (tool === "rg" || tool === "grep") return tool;
	throw new Error("远程未找到 rg 或 grep");
}

function createRemoteLsOps(remote: string, remoteCwd: string, localCwd: string): LsOperations {
	const toRemote = (p: string) => toRemotePath(p, localCwd, remoteCwd);
	return {
		exists: (p) => remotePathExists(remote, toRemote(p)),
		stat: async (p) => {
			const remotePath = toRemote(p);
			if (!(await remotePathExists(remote, remotePath))) throw new Error(`Path not found: ${p}`);
			const isDirectory = await remotePathExists(remote, `${remotePath}/.`);
			return { isDirectory: () => isDirectory };
		},
		readdir: async (p) => {
			const remotePath = toRemote(p);
			const output = await execShell(remote, `find ${quoteRemoteArg(remotePath)} -mindepth 1 -maxdepth 1 -printf '%f\\n'`);
			return output.toString().split(/\r?\n/).filter(Boolean);
		},
	};
}

function createRemoteFindOps(remote: string, remoteCwd: string, localCwd: string): FindOperations {
	const toRemote = (p: string) => toRemotePath(p, localCwd, remoteCwd);
	return {
		exists: (p) => remotePathExists(remote, toRemote(p)),
		glob: async (pattern, cwd, { ignore, limit }) => {
			const remotePath = toRemote(cwd);
			const maxResults = Math.max(1, Math.floor(limit));
			// GNU find 的 -path 不支持 ** 跨层，改用扩展正则精确表达 glob
			const regexArgs = [
				...ignore.flatMap((item) => ["!", "-regex", globToFindRegex(item, remotePath)]),
				"-regex",
				globToFindRegex(pattern, remotePath),
			];
			const command = [
				"find",
				quoteRemoteArg(remotePath),
				"-regextype",
				"posix-extended",
				"-type",
				"f",
				...regexArgs.map(quoteRemoteArg),
				"-print",
				"|",
				"head",
				"-n",
				String(maxResults),
			].join(" ");
			const output = await execShell(remote, command);
			return output.toString().split(/\r?\n/).filter(Boolean).map((p) => remoteToMirror(p, localCwd));
		},
	};
}

function createRemoteReadOps(remote: string, remoteCwd: string, localCwd: string): ReadOperations {
	const toRemote = (p: string) => toRemotePath(p, localCwd, remoteCwd);
	return {
		readFile: (p) => execShell(remote, `cat ${quoteRemoteArg(toRemote(p))}`),
		access: async (p) => {
			const remotePath = toRemote(p);
			const output = await execShell(
				remote,
				`if test -r ${quoteRemoteArg(remotePath)}; then printf 1; else printf 0; fi`,
			);
			if (output.toString().trim() !== "1") throw new Error(`Path not readable: ${remotePath}`);
		},
		detectImageMimeType: async (p) => {
			try {
				const r = await execShell(remote, `file --mime-type -b ${JSON.stringify(toRemote(p))}`);
				const m = r.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

function createRemoteWriteOps(remote: string, remoteCwd: string, localCwd: string): WriteOperations {
	const toRemote = (p: string) => toRemotePath(p, localCwd, remoteCwd);
	return {
		writeFile: async (p, content) => {
			await execShell(remote, `cat > ${quoteRemoteArg(toRemote(p))}`, Buffer.from(content));
		},
		mkdir: (dir) => execShell(remote, `mkdir -p ${JSON.stringify(toRemote(dir))}`).then(() => {}),
	};
}

function createRemoteEditOps(remote: string, remoteCwd: string, localCwd: string): EditOperations {
	const r = createRemoteReadOps(remote, remoteCwd, localCwd);
	const w = createRemoteWriteOps(remote, remoteCwd, localCwd);
	return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createPowerShellLsOps(remote: string, remoteCwd: string, localCwd: string): LsOperations {
	const toRemote = (p: string) => toRemotePath(p, localCwd, remoteCwd);
	return {
		exists: (p) => remotePathExists(remote, toRemote(p)),
		stat: async (p) => {
			const remotePath = toRemote(p);
			if (!(await remotePathExists(remote, remotePath))) throw new Error(`Path not found: ${p}`);
			const isDirectory = await remotePathIsDirectory(remote, remotePath);
			return { isDirectory: () => isDirectory };
		},
		readdir: async (p) => {
			const output = await execShell(
				remote,
				`Get-ChildItem -LiteralPath ${psQuote(toRemote(p))} -Force | Select-Object -ExpandProperty Name`,
			);
			return output.toString().split(/\r?\n/).filter(Boolean);
		},
	};
}

function createPowerShellFindOps(remote: string, remoteCwd: string, localCwd: string): FindOperations {
	const toRemote = (p: string) => toRemotePath(p, localCwd, remoteCwd);
	return {
		exists: (p) => remotePathExists(remote, toRemote(p)),
		glob: async (pattern, cwd, { ignore, limit }) => {
			const searchRoot = toRemote(cwd);
			const maxResults = Math.max(1, Math.floor(limit));
			// 远端用 .NET 正则过滤（-match 默认不区分大小写），只回传命中的绝对路径
			const output = await execShell(
				remote,
				[
					`$root = ${psQuote(searchRoot)}`,
					`$pat = ${psQuote(globToFindRegex(pattern, searchRoot))}`,
					`$ign = @(${ignore.map((item) => psQuote(globToFindRegex(item, searchRoot))).join(", ")})`,
					`$max = ${maxResults}`,
					"$n = 0",
					"foreach ($f in (Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue)) {",
					"  $p = $f.FullName.Replace('\\','/')",
					"  $hit = $p -match $pat",
					"  if ($hit) { foreach ($r in $ign) { if ($p -match $r) { $hit = $false; break } } }",
					"  if ($hit) { $p; $n++ }",
					"  if ($n -ge $max) { break }",
					"}",
				].join("\n"),
			);
			return output.toString().split(/\r?\n/).filter(Boolean).map((p) => remoteToMirror(p, localCwd));
		},
	};
}

function createPowerShellReadOps(remote: string, remoteCwd: string, localCwd: string): ReadOperations {
	const toRemote = (p: string) => toRemotePath(p, localCwd, remoteCwd);
	return {
		// 字节直传：文本不被本地解码器改写，图片也保留原始数据
		readFile: async (p) => {
			const output = await execShell(remote, `[Convert]::ToBase64String([IO.File]::ReadAllBytes(${psQuote(toRemote(p))}))`);
			return Buffer.from(output.toString().trim(), "base64");
		},
		access: async (p) => {
			await execShell(remote, `Get-Item -LiteralPath ${psQuote(toRemote(p))} -Force | Out-Null`);
		},
		// Windows 远端没有 file 命令，图片类型按扩展名判断
		detectImageMimeType: async (p) => IMAGE_MIME_BY_EXTENSION[path.posix.extname(toRemote(p)).toLowerCase()] ?? null,
	};
}

function createPowerShellWriteOps(remote: string, remoteCwd: string, localCwd: string): WriteOperations {
	const toRemote = (p: string) => toRemotePath(p, localCwd, remoteCwd);
	return {
		// 内容走 base64 与 stdin，避开命令行长度上限
		// 必须用 PowerShell 自己的输入管道 $input 收：直接读标准输入（[Console]::In.ReadToEnd 或 OpenStandardInput.Read）
		// 在数据量上来时会永久卡住（实测 >110KB 必卡在 72KB 处，9KB 级别也偶发丢 EOF）
		writeFile: async (p, content) => {
			const base64 = Buffer.from(content, "utf8").toString("base64");
			const script = [
				'$b64 = ($input | Out-String).Replace("`r", "").Replace("`n", "")',
				`if ($b64.Length -ne ${base64.length}) { throw "stdin 只到 $($b64.Length)/${base64.length} 字符" }`,
				`[IO.File]::WriteAllBytes(${psQuote(toRemote(p))}, [Convert]::FromBase64String($b64))`,
			].join("\n");
			// 末尾补换行，$input 按行喂进来
			await execShell(remote, script, Buffer.from(`${base64}\n`, "ascii"));
		},
		mkdir: async (dir) => {
			await execShell(remote, `[IO.Directory]::CreateDirectory(${psQuote(toRemote(dir))}) | Out-Null`);
		},
	};
}

function createPowerShellEditOps(remote: string, remoteCwd: string, localCwd: string): EditOperations {
	const r = createPowerShellReadOps(remote, remoteCwd, localCwd);
	const w = createPowerShellWriteOps(remote, remoteCwd, localCwd);
	return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

export interface EditRequest {
	oldText: string;
	newText: string;
}

export interface EditPlan {
	/** 待写入的完整文件内容，BOM 已还原 */
	finalContent: string;
	diff: string;
	patch: string;
	firstChangedLine?: number;
}

interface Skeleton {
	text: string;
	/** 骨架第 i 个字符在原文的下标，末项为原文长度 */
	offsets: number[];
}

interface Replacement {
	start: number;
	end: number;
	text: string;
	editIndex: number;
}

/** 无宽度字符：BOM、零宽空格系列、方向控制、软连字符 */
const ZERO_WIDTH = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

/** 与 ASCII 1:1 等价的字符，长度不变才不破坏位置映射 */
const EQUIVALENTS: Record<string, string> = {
	"\u2018": "'",
	"\u2019": "'",
	"\u201A": "'",
	"\u201B": "'",
	"\u201C": '"',
	"\u201D": '"',
	"\u201E": '"',
	"\u201F": '"',
	"\u2010": "-",
	"\u2011": "-",
	"\u2012": "-",
	"\u2013": "-",
	"\u2014": "-",
	"\u2015": "-",
	"\u2212": "-",
	"\u00A0": " ",
	"\u2000": " ",
	"\u2001": " ",
	"\u2002": " ",
	"\u2003": " ",
	"\u2004": " ",
	"\u2005": " ",
	"\u2006": " ",
	"\u2007": " ",
	"\u2008": " ",
	"\u2009": " ",
	"\u200A": " ",
	"\u202F": " ",
	"\u205F": " ",
	"\u3000": " ",
};

/** 二级骨架整体剔除的空白 */
const BLANK = new Set([" ", "\t", "\n", "\f", "\v", "\u0085", "\u2028", "\u2029"]);

/** 行内水平空白，含经等价映射后的 Unicode 空格 */
const HORIZONTAL = /[ \t\f\v\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/;

function isHorizontalSpace(char: string | undefined): boolean {
	return char !== undefined && HORIZONTAL.test(char);
}

function endsWithLineBreak(text: string): boolean {
	return text.endsWith("\n") || text.endsWith("\r");
}

/**
 * 建骨架：ignoreBlank 为 false 时只丢掉无宽度字符与 \r，为 true 时连空白一起丢掉
 * offsets 让骨架上的命中原样换算回原文位置，不靠重新对齐
 */
function buildSkeleton(source: string, ignoreBlank: boolean): Skeleton {
	const chars: string[] = [];
	const offsets: number[] = [];
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		// \r 一并剔除，CRLF 与 LF 因此在骨架上互通
		if (char === "\r" || ZERO_WIDTH.test(char)) continue;
		const mapped = EQUIVALENTS[char] ?? char;
		if (ignoreBlank && BLANK.has(mapped)) continue;
		chars.push(mapped);
		offsets.push(index);
	}
	offsets.push(source.length);
	return { text: chars.join(""), offsets };
}

/** 骨架里 needle 出现的位置，取到 limit 处即停 */
function matchAll(haystack: string, needle: string, limit = 2): number[] {
	const found: number[] = [];
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
		found.push(at);
		if (found.length === limit) break;
	}
	return found;
}

/** 区间起点所在行的行尾：自己的换行，末行无换行时用前一个 */
function lineEndingAt(source: string, offset: number): string {
	let lineFeed = source.indexOf("\n", offset);
	if (lineFeed === -1) lineFeed = source.lastIndexOf("\n", offset);
	if (lineFeed === -1) return source.includes("\r") ? "\r" : "\n";
	return source[lineFeed - 1] === "\r" ? "\r\n" : "\n";
}

/** newText 的换行按原文该处的行尾写入，避免 CRLF 文件混入裸 LF */
function withLineEnding(source: string, offset: number, newText: string): string {
	const ending = lineEndingAt(source, offset);
	const lineFeeds = newText.replace(/\r\n/g, "\n");
	return ending === "\n" ? lineFeeds : lineFeeds.replace(/\n/g, ending);
}

/** 统一成 LF 再算 diff，行尾风格差异不该显示成整篇改动 */
function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function editLabel(index: number, total: number): string {
	return total === 1 ? "oldText" : `edits[${index}].oldText`;
}

function notFoundError(index: number, total: number, path: string): Error {
	return new Error(
		`Could not find ${editLabel(index, total)} in ${path} even after ignoring whitespace, line endings and invisible characters. Check the text with read.`,
	);
}

function duplicateError(index: number, total: number, path: string): Error {
	return new Error(
		`Found more than one occurrence of ${editLabel(index, total)} in ${path} after ignoring whitespace. Add surrounding lines to make it unique.`,
	);
}

/** 整行删除时连缩进和换行一并删，否则会留下空行或把缩进贴给下一行；行内局部删除不受影响 */
function wholeLineDeletion(source: string, start: number, end: number, editIndex: number): Replacement | undefined {
	let from = start;
	while (from > 0 && isHorizontalSpace(source[from - 1])) from--;
	if (from > 0 && !endsWithLineBreak(source[from - 1])) return undefined;
	let to = end;
	// 命中区可能已含行尾换行，此时行尾就是 end
	if (!(to > start && endsWithLineBreak(source[to - 1]))) {
		while (to < source.length && isHorizontalSpace(source[to])) to++;
		if (to < source.length && !endsWithLineBreak(source[to])) return undefined;
		if (source.startsWith("\r\n", to)) to += 2;
		else if (to < source.length) to += 1;
	}
	return { start: from, end: to, text: "", editIndex };
}

/**
 * 二级命中的区间只覆盖可见字符，缩进与行尾空白留在区间外
 * oldText 与 newText 都以缩进开头、或都以换行结尾（newText 为空表示整段删除）时两侧语义对称，
 * 把原文的缩进 / 行尾空白一并纳入替换，否则会叠出两层缩进、多出一个空行或留下空缩进行
 */
function widenBalanced(source: string, start: number, end: number, edit: EditRequest, editIndex: number): Replacement {
	let from = start;
	let to = end;
	const removesWholeLine = edit.newText.length === 0;
	if (isHorizontalSpace(edit.oldText[0]) && (removesWholeLine || isHorizontalSpace(edit.newText[0]))) {
		while (from > 0 && isHorizontalSpace(source[from - 1])) from--;
	}
	if (endsWithLineBreak(edit.oldText) && (removesWholeLine || endsWithLineBreak(edit.newText))) {
		let after = to;
		while (after < source.length && isHorizontalSpace(source[after])) after++;
		if (source.startsWith("\r\n", after)) after += 2;
		else if (after < source.length && (source[after] === "\n" || source[after] === "\r")) after += 1;
		to = after;
	}
	return { start: from, end: to, text: withLineEnding(source, from, edit.newText), editIndex };
}

/** 命中区间转成替换：整行删除优先，宽松命中再平衡缩进与行尾空白 */
function toReplacement(source: string, start: number, end: number, edit: EditRequest, editIndex: number, widen: boolean): Replacement {
	if (edit.newText.length === 0) {
		const wholeLine = wholeLineDeletion(source, start, end, editIndex);
		if (wholeLine) return wholeLine;
	}
	if (!widen) return { start, end, text: withLineEnding(source, start, edit.newText), editIndex };
	return widenBalanced(source, start, end, edit, editIndex);
}

/** 单条 edit 定位到原文区间，先用严格骨架，命中不了再用忽略空白的骨架 */
function resolveEdit(
	source: string,
	strict: Skeleton,
	loose: () => Skeleton,
	edit: EditRequest,
	index: number,
	total: number,
	path: string,
): Replacement {
	const looseNeedle = buildSkeleton(edit.oldText, true).text;
	if (looseNeedle.length === 0) {
		throw new Error(`${editLabel(index, total)} contains only whitespace or invisible characters in ${path}.`);
	}
	const strictNeedle = buildSkeleton(edit.oldText, false).text;
	const strictHits = strictNeedle.length > 0 ? matchAll(strict.text, strictNeedle) : [];
	if (strictHits.length > 1) throw duplicateError(index, total, path);
	if (strictHits.length === 1) {
		const start = strict.offsets[strictHits[0]];
		const end = strict.offsets[strictHits[0] + strictNeedle.length - 1] + 1;
		return toReplacement(source, start, end, edit, index, false);
	}
	const looseSkeleton = loose();
	const looseHits = matchAll(looseSkeleton.text, looseNeedle);
	if (looseHits.length === 0) throw notFoundError(index, total, path);
	if (looseHits.length > 1) throw duplicateError(index, total, path);
	const start = looseSkeleton.offsets[looseHits[0]];
	const end = looseSkeleton.offsets[looseHits[0] + looseNeedle.length - 1] + 1;
	return toReplacement(source, start, end, edit, index, true);
}

/**
 * 把多条 edit 应用到原文，返回写入内容与 diff
 * 所有 edit 都对照同一份原文定位，重叠视为错误
 */
export function planEdit(rawContent: string, edits: EditRequest[], displayPath: string): EditPlan {
	const bom = rawContent.startsWith("\uFEFF") ? "\uFEFF" : "";
	const source = bom ? rawContent.slice(1) : rawContent;
	const strict = buildSkeleton(source, false);
	let looseSkeleton: Skeleton | undefined;
	const loose = () => (looseSkeleton ??= buildSkeleton(source, true));
	const replacements = edits
		.map((edit, index) => resolveEdit(source, strict, loose, edit, index, edits.length, displayPath))
		.sort((a, b) => a.start - b.start);
	for (let index = 1; index < replacements.length; index++) {
		const previous = replacements[index - 1];
		const current = replacements[index];
		if (previous.end > current.start) {
			throw new Error(`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${displayPath}. Merge them into one edit.`);
		}
	}
	let updated = "";
	let cursor = 0;
	for (const replacement of replacements) {
		updated += source.slice(cursor, replacement.start) + replacement.text;
		cursor = replacement.end;
	}
	updated += source.slice(cursor);
	if (updated === source) {
		throw new Error(`No changes made to ${displayPath}. The replacement produced identical content.`);
	}
	const before = normalizeToLF(source);
	const after = normalizeToLF(updated);
	const { diff, firstChangedLine } = generateDiffString(before, after);
	return { finalContent: bom + updated, diff, patch: generateUnifiedPatch(displayPath, before, after), firstChangedLine };
}

function isEditRequest(value: unknown): value is EditRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

/** 按 pi 的 edit 入参约定取出路径与 edits；edits 可能是 JSON 字符串或单个对象，另兼容顶层 oldText/newText */
function normalizeEditInput(params: unknown): { path: string; edits: EditRequest[] } {
	if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Edit tool input is invalid");
	const input = params as Record<string, unknown>;
	const target = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
	if (!target) throw new Error("Edit tool input is invalid: path is required");
	let edits = input.edits;
	if (typeof edits === "string") {
		try {
			edits = JSON.parse(edits);
		} catch {
			edits = undefined;
		}
	}
	if (isEditRequest(edits)) edits = [edits];
	const list = Array.isArray(edits) ? edits : [];
	if (!list.every(isEditRequest)) throw new Error("Edit tool input is invalid: each edit needs string oldText and newText");
	if (typeof input.oldText === "string" && typeof input.newText === "string") {
		list.push({ oldText: input.oldText, newText: input.newText });
	}
	if (list.length === 0) throw new Error("Edit tool input is invalid: edits must contain at least one replacement");
	return { path: target, edits: list };
}

/** 相对路径按会话 cwd 解析，展开 ~ 与 @ 前缀，路径里的 Unicode 空格按普通空格处理 */
function resolveToolPath(input: string, cwd: string): string {
	const trimmed = input.startsWith("@") ? input.slice(1) : input;
	const normalized = trimmed.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (normalized === "~" || normalized === "~/") return os.homedir();
	if (normalized.startsWith("~/") || normalized.startsWith("~\\")) return path.join(os.homedir(), normalized.slice(2));
	return path.isAbsolute(normalized) ? normalized : path.resolve(cwd, normalized);
}

/** edit 执行：匹配与写回交给 edit-match，读写经 EditOperations，本地时走 fs */
async function executeEdit(cwd: string, filePath: string, edits: EditRequest[], operations: EditOperations | undefined, signal?: AbortSignal) {
	const absolutePath = resolveToolPath(filePath, cwd);
	const readFile = operations?.readFile ?? ((file: string) => fs.promises.readFile(file));
	const writeFile = operations?.writeFile ?? ((file: string, content: string) => fs.promises.writeFile(file, content, "utf-8"));
	const access = operations?.access ?? ((file: string) => fs.promises.access(file, fs.constants.R_OK | fs.constants.W_OK));
	return withFileMutationQueue(absolutePath, async () => {
		if (signal?.aborted) throw new Error("Operation aborted");
		try {
			await access(absolutePath);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Could not edit file: ${filePath}. ${detail}.`);
		}
		const rawContent = (await readFile(absolutePath)).toString("utf-8");
		if (signal?.aborted) throw new Error("Operation aborted");
		const plan = planEdit(rawContent, edits, filePath);
		await writeFile(absolutePath, plan.finalContent);
		return {
			content: [{ type: "text" as const, text: `Successfully replaced ${edits.length} block(s) in ${filePath}.` }],
			details: { diff: plan.diff, patch: plan.patch, firstChangedLine: plan.firstChangedLine },
		};
	});
}

/** 原生 ssh 执行（key 认证），输出按块回调 */
function sshRun(remote: string, cmd: string, options: { onData?: (d: Buffer) => void; signal?: AbortSignal; timeout?: number }): Promise<{ exitCode: number | null }> {
	return new Promise((resolve, reject) => {
		const { bin, args, env } = buildSshInvocation(remote, cmd);
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
		let timedOut = false;
		const timer = options.timeout
			? setTimeout(() => {
					timedOut = true;
					child.kill();
				}, options.timeout * 1000)
			: undefined;
		child.stdout.on("data", (d) => options.onData?.(d));
		child.stderr.on("data", (d) => options.onData?.(d));
		child.on("error", (e) => {
			if (timer) clearTimeout(timer);
			reject(e);
		});
		const onAbort = () => child.kill();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (options.signal?.aborted) reject(new Error("aborted"));
			else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
			else resolve({ exitCode: code });
		});
	});
}

function createRemoteBashOps(remote: string, remoteCwd: string, localCwd: string): BashOperations {
	const toRemote = (p: string) => toRemotePath(p, localCwd, remoteCwd);
	return {
		exec: (command, cwd, { onData, signal, timeout }) => {
			const cmd = `cd ${JSON.stringify(toRemote(cwd))} && ${command}`;
			if (process.env.PI_WEB_SSH_PASSWORD) {
				return plinkOutput(remote, cmd, { onData, signal, timeout }).then((r) => ({ exitCode: r.code ?? 1 }));
			}
			return sshRun(remote, cmd, { onData, signal, timeout });
		},
	};
}

function createPowerShellRemoteOps(remote: string, remoteCwd: string, localCwd: string): BashOperations {
	const toRemote = (p: string) => toRemotePath(p, localCwd, remoteCwd);
	return {
		exec: (command, cwd, { onData, signal, timeout }) => {
			const cmd = remoteScript(`Set-Location -LiteralPath ${psQuote(toRemote(cwd))}\n${command}`);
			if (process.env.PI_WEB_SSH_PASSWORD) {
				return plinkOutput(remote, cmd, { onData, signal, timeout }).then((r) => ({ exitCode: r.code ?? 1 }));
			}
			return sshRun(remote, cmd, { onData, signal, timeout });
		},
	};
}

/** 远端 shell 工具的 operations，按当前远端 shell 分派 */
function remoteShellOps(remote: string, remoteCwd: string, localCwd: string): BashOperations {
	return isPowerShellRemote()
		? createPowerShellRemoteOps(remote, remoteCwd, localCwd)
		: createRemoteBashOps(remote, remoteCwd, localCwd);
}

async function executeRemoteGrep(
	ssh: SshTarget,
	localCwd: string,
	params: unknown,
	signal?: AbortSignal,
) {
	if (signal?.aborted) throw new Error("Operation aborted");
	const input = params as {
		pattern: string;
		path?: string;
		glob?: string;
		ignoreCase?: boolean;
		literal?: boolean;
		context?: number;
		limit?: number;
	};
	const remotePath = input.path ? resolveRemotePath(input.path, localCwd, ssh) : ssh.remoteCwd;
	if (!(await remotePathExists(ssh.remote, remotePath))) throw new Error(`Path not found: ${input.path ?? remotePath}`);
	const isDirectory = await remotePathExists(ssh.remote, `${remotePath}/.`);
	const workDir = isDirectory ? remotePath : path.posix.dirname(remotePath);
	const target = isDirectory ? "." : path.posix.basename(remotePath);
	const tool = await resolveRemoteGrepTool(ssh.remote);
	const args = tool === "rg"
		? ["rg", "--line-number", "--color=never", "--hidden", "--no-heading"]
		: ["grep", "-r", "-n", "-H", "-I", "--exclude-dir", "node_modules", "--exclude-dir", ".git"];
	if (input.ignoreCase) args.push(tool === "rg" ? "--ignore-case" : "-i");
	if (input.literal) args.push(tool === "rg" ? "--fixed-strings" : "-F");
	if (input.context && input.context > 0) args.push("-C", String(Math.floor(input.context)));
	if (tool === "rg") {
		args.push("--glob", "!**/node_modules/**", "--glob", "!**/.git/**");
		if (input.glob) args.push("--glob", input.glob);
	} else if (input.glob) {
		args.push("--include", input.glob);
	}
	args.push(tool === "rg" ? "--" : "-e", input.pattern, target);
	const command = [
		`cd ${quoteRemoteArg(workDir)} &&`,
		args.map(quoteRemoteArg).join(" "),
		`; status=$?; if [ "$status" -eq 1 ]; then exit 0; fi; exit "$status"`,
	].join(" ");
	const output = (await execShell(ssh.remote, command)).toString().trimEnd();
	if (!output) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
	const limit = Math.max(1, Math.floor(input.limit ?? 100));
	// grep -r 输出带 ./ 前缀，去掉以对齐本地 pi 的显示
	const lines = output.split(/\r?\n/).map((line) => line.replace(/^\.\//, ""));
	const limited = lines.slice(0, limit).join("\n");
	return {
		content: [{ type: "text" as const, text: limited }],
		details: lines.length > limit ? { matchLimitReached: limit } : undefined,
	};
}

/** grep 的 glob 过滤：无斜杠的 glob 按 rg 习惯匹配任意层级 */
function grepGlobRegex(glob: string, searchRoot: string): string {
	return globToFindRegex(glob.includes("/") ? glob : `**/${glob}`, searchRoot);
}

/** PowerShell 远端 grep：远端只回传命中行的 JSON，上下文与显示格式在本地拼装 */
async function executePowerShellGrep(ssh: SshTarget, localCwd: string, params: unknown, signal?: AbortSignal) {
	if (signal?.aborted) throw new Error("Operation aborted");
	const input = params as {
		pattern: string;
		path?: string;
		glob?: string;
		ignoreCase?: boolean;
		literal?: boolean;
		context?: number;
		limit?: number;
	};
	const remotePath = input.path ? resolveRemotePath(input.path, localCwd, ssh) : ssh.remoteCwd;
	if (!(await remotePathExists(ssh.remote, remotePath))) throw new Error(`Path not found: ${input.path ?? remotePath}`);
	const isDirectory = await remotePathIsDirectory(ssh.remote, remotePath);
	const workDir = isDirectory ? remotePath : path.posix.dirname(remotePath);
	const limit = Math.max(1, Math.floor(input.limit ?? 100));
	const context = input.context && input.context > 0 ? Math.floor(input.context) : 0;
	const pattern = input.literal ? escapeRegExp(input.pattern) : input.pattern;
	const script = [
		`$root = ${psQuote(remotePath)}`,
		`$isFile = ${isDirectory ? "$false" : "$true"}`,
		`$rx = New-Object System.Text.RegularExpressions.Regex(${psQuote(pattern)}, [System.Text.RegularExpressions.RegexOptions]::${input.ignoreCase ? "IgnoreCase" : "None"})`,
		`$glob = ${input.glob ? psQuote(grepGlobRegex(input.glob, workDir)) : "$null"}`,
		`$max = ${limit}`,
		"$n = 0",
		"$files = if ($isFile) { @(Get-Item -LiteralPath $root -Force) } else { @(Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue) }",
		"foreach ($f in $files) {",
		"  $p = $f.FullName.Replace('\\','/')",
		"  if ($p -like '*/node_modules/*' -or $p -like '*/.git/*') { continue }",
		"  if ($glob -and -not ($p -match $glob)) { continue }",
		"  $lines = $null",
		"  try { $lines = [IO.File]::ReadAllLines($f.FullName) } catch { continue }",
		"  for ($i = 0; $i -lt $lines.Length; $i++) {",
		"    if ($rx.IsMatch($lines[$i])) {",
		"      ConvertTo-Json -InputObject @{ path = $p; line = $i + 1; text = $lines[$i] } -Compress",
		"      $n++",
		"      if ($n -ge $max) { break }",
		"    }",
		"  }",
		"  if ($n -ge $max) { break }",
		"}",
	].join("\n");
	const output = (await execShell(ssh.remote, script)).toString().trim();
	if (!output) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
	const matches = output
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { path: string; line: number; text: string });
	const formatPath = (filePath: string) =>
		isDirectory ? path.posix.relative(workDir, filePath).replaceAll("\\", "/") : path.posix.basename(filePath);
	const fileCache = new Map<string, string[]>();
	const readRemoteLines = async (filePath: string) => {
		let lines = fileCache.get(filePath);
		if (!lines) {
			const raw = await execShell(ssh.remote, `[Convert]::ToBase64String([IO.File]::ReadAllBytes(${psQuote(filePath)}))`);
			lines = Buffer.from(raw.toString().trim(), "base64").toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			fileCache.set(filePath, lines);
		}
		return lines;
	};
	const outputLines: string[] = [];
	for (const match of matches) {
		const relative = formatPath(match.path);
		if (context === 0) {
			outputLines.push(`${relative}:${match.line}: ${match.text}`);
			continue;
		}
		const lines = await readRemoteLines(match.path);
		const start = Math.max(1, match.line - context);
		const end = Math.min(lines.length, match.line + context);
		for (let current = start; current <= end; current++) {
			const text = (lines[current - 1] ?? "").replace(/\r/g, "");
			// 匹配行用冒号、上下文行用短横，与 SDK 的 grep 显示一致
			outputLines.push(current === match.line ? `${relative}:${current}: ${text}` : `${relative}-${current}- ${text}`);
		}
	}
	const matchLimitReached = matches.length >= limit;
	const text = matchLimitReached
		? `${outputLines.join("\n")}\n\n[${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern]`
		: outputLines.join("\n");
	return { content: [{ type: "text" as const, text }], details: matchLimitReached ? { matchLimitReached: limit } : undefined };
}

// 宿主的运行时变量不应泄漏给项目命令
function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const cleaned = { ...env };
	for (const key of Object.keys(cleaned)) {
		const comparable = process.platform === "win32" ? key.toUpperCase() : key;
		// npm run 起的服务把自身的调用信息也带进了子进程
		const fromNpm = key.toLowerCase().startsWith("npm_");
		if (
			fromNpm
			|| comparable === "PORT"
			|| comparable === "NODE_ENV"
			|| comparable === "INIT_CWD"
			|| comparable === "PI_WEB_PASSWORD"
			|| comparable === "PI_WEB_SSH_PASSWORD"
			|| comparable.startsWith("NEXT_")
			|| comparable.startsWith("__NEXT_")
		) {
			delete cleaned[key];
		}
	}
	return cleaned;
}

// 本地执行时清洗 env，阻断宿主变量透传
function createSanitizedLocalBashOps(): BashOperations {
	const local = createLocalBashOperations();
	return {
		exec: (command, execCwd, options) =>
			local.exec(command, execCwd, { ...options, env: sanitizeEnv(options.env ?? process.env) }),
	};
}

// 本地 PowerShell 走同一套清洗，否则它绕过 bash 那条路
function createSanitizedLocalPowerShellOps(): BashOperations {
	const local = createLocalPowerShellOperations();
	return {
		exec: (command, execCwd, options) =>
			local.exec(command, execCwd, { ...options, env: sanitizeEnv(options.env ?? process.env) }),
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });

	// pi-web 的进程 cwd 是宿主根目录，会话 cwd 须在 session_start 用 ctx.cwd 绑定
	let sessionCwd = process.cwd();
	const localRead = createReadTool(sessionCwd);
	const localWrite = createWriteTool(sessionCwd);
	const localEdit = createEditTool(sessionCwd);
	const localLs = createLsTool(sessionCwd);
	const localFind = createFindTool(sessionCwd);
	const localGrep = createGrepTool(sessionCwd);
	const localBashOps = createSanitizedLocalBashOps();
	const localBash = createBashTool(sessionCwd, { operations: localBashOps });
	const localPowerShell = createPowerShellTool(sessionCwd);

	// Resolved lazily on session_start (CLI flags not available during factory)
	let resolvedSsh: SshTarget | null = null;

	const getSsh = () => resolvedSsh;
	const isSshConfigured = () => Boolean(process.env.PI_WEB_SSH || typeof pi.getFlag("ssh") === "string");
	const requireSsh = () => {
		const ssh = getSsh();
		if (ssh) return ssh;
		if (isSshConfigured()) throw new Error("SSH 未连接，已拒绝本地执行");
		return undefined;
	};

	pi.registerTool({
		...localRead,
		promptSnippet: "Read file contents",
		promptGuidelines: ["Use read to examine files instead of cat or sed."],
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = requireSsh();
			const ops = ssh
				? (isPowerShellRemote()
					? createPowerShellReadOps(ssh.remote, ssh.remoteCwd, sessionCwd)
					: createRemoteReadOps(ssh.remote, ssh.remoteCwd, sessionCwd))
				: undefined;
			const tool = createReadTool(sessionCwd, ops ? { operations: ops } : undefined);
			const input = ssh ? { ...params, path: toMirrorPath(params.path, sessionCwd, ssh) } : params;
			if (!ssh) return tool.execute(id, input, signal, onUpdate);
			return withRemotePaths(sessionCwd, ssh, () => tool.execute(id, input, signal, onUpdate));
		},
	});

	pi.registerTool({
		...localWrite,
		promptSnippet: "Create or overwrite files",
		promptGuidelines: ["Use write only for new files or complete rewrites."],
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = requireSsh();
			const ops = ssh
				? (isPowerShellRemote()
					? createPowerShellWriteOps(ssh.remote, ssh.remoteCwd, sessionCwd)
					: createRemoteWriteOps(ssh.remote, ssh.remoteCwd, sessionCwd))
				: undefined;
			const tool = createWriteTool(sessionCwd, ops ? { operations: ops } : undefined);
			const input = ssh ? { ...params, path: toMirrorPath(params.path, sessionCwd, ssh) } : params;
			if (!ssh) return tool.execute(id, input, signal, onUpdate);
			return withRemotePaths(sessionCwd, ssh, () => tool.execute(id, input, signal, onUpdate));
		},
	});

	pi.registerTool({
		...localEdit,
		promptSnippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		promptGuidelines: [
			"Use edit for precise changes (edits[].oldText must match exactly)",
			"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
			"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
			"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
		],
		async execute(_id, params, signal, _onUpdate, _ctx) {
			const ssh = requireSsh();
			const { path: filePath, edits } = normalizeEditInput(params);
			const target = ssh ? toMirrorPath(filePath, sessionCwd, ssh) : filePath;
			const ops = ssh
				? (isPowerShellRemote()
					? createPowerShellEditOps(ssh.remote, ssh.remoteCwd, sessionCwd)
					: createRemoteEditOps(ssh.remote, ssh.remoteCwd, sessionCwd))
				: undefined;
			const run = () => executeEdit(sessionCwd, target, edits, ops, signal);
			if (!ssh) return run();
			return withRemotePaths(sessionCwd, ssh, run);
		},
	});

	pi.registerTool({
		...localLs,
		promptSnippet: "List directory contents",
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = requireSsh();
			if (!ssh) return localLs.execute(id, params, signal, onUpdate);
			const tool = createLsTool(sessionCwd, {
				operations: isPowerShellRemote()
					? createPowerShellLsOps(ssh.remote, ssh.remoteCwd, sessionCwd)
					: createRemoteLsOps(ssh.remote, ssh.remoteCwd, sessionCwd),
			});
			const input = params.path ? { ...params, path: toMirrorPath(params.path, sessionCwd, ssh) } : params;
			return withRemotePaths(sessionCwd, ssh, () => tool.execute(id, input, signal, onUpdate));
		},
	});

	pi.registerTool({
		...localFind,
		promptSnippet: "Find files by glob pattern (respects .gitignore)",
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = requireSsh();
			if (!ssh) return localFind.execute(id, params, signal, onUpdate);
			const tool = createFindTool(sessionCwd, {
				operations: isPowerShellRemote()
					? createPowerShellFindOps(ssh.remote, ssh.remoteCwd, sessionCwd)
					: createRemoteFindOps(ssh.remote, ssh.remoteCwd, sessionCwd),
			});
			const input = params.path ? { ...params, path: toMirrorPath(params.path, sessionCwd, ssh) } : params;
			return withRemotePaths(sessionCwd, ssh, () => tool.execute(id, input, signal, onUpdate));
		},
	});

	pi.registerTool({
		...localGrep,
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		async execute(_id, params, signal) {
			const ssh = requireSsh();
			if (!ssh) return localGrep.execute(_id, params, signal);
			return withRemotePaths(sessionCwd, ssh, () =>
				isPowerShellRemote()
					? executePowerShellGrep(ssh, sessionCwd, params, signal)
					: executeRemoteGrep(ssh, sessionCwd, params, signal));
		},
	});

	pi.registerTool({
		...localBash,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		promptGuidelines: ["You can inspect PI_* environment variables for current model and session details."],
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = requireSsh();
			const ops = ssh ? remoteShellOps(ssh.remote, ssh.remoteCwd, sessionCwd) : createSanitizedLocalBashOps();
			const tool = createBashTool(sessionCwd, { operations: ops });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	// --ps 时注册远端 PowerShell 工具，覆盖内置的那个（内置的会绕过 SSH 打本机）
	pi.registerTool({
		...localPowerShell,
		promptSnippet: "Execute PowerShell commands",
		promptGuidelines: ["You can inspect PI_* environment variables for current model and session details."],
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = requireSsh();
			const ops = ssh ? remoteShellOps(ssh.remote, ssh.remoteCwd, sessionCwd) : createSanitizedLocalPowerShellOps();
			const tool = createPowerShellTool(sessionCwd, { operations: ops });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// 绑定会话 cwd（pi CLI 下等于进程 cwd，pi-web 下以 ctx.cwd 为准）
		sessionCwd = ctx.cwd;
		// pi-web 经 ssh-launcher 注入 PI_WEB_SSH，pi CLI 直接传 --ssh flag
		const flag = pi.getFlag("ssh");
		const arg = process.env.PI_WEB_SSH ?? (typeof flag === "string" ? flag : undefined);
		// --ps 由 ssh-launcher 注入，远端是 Windows 时整套远端操作改用 PowerShell
		remoteShell = process.env.PI_WEB_SSH_SHELL === "powershell" ? "powershell" : "bash";
		if (arg) {
			try {
				const sep = arg.indexOf(":");
				const suffix = sep >= 0 ? arg.slice(sep + 1) : "";
				// 冒号后纯数字视为端口（host:2222），其余视为远程路径（host:/remote/path）
				const portOnly = sep >= 0 && /^\d+$/.test(suffix);
				const remote = sep >= 0 ? arg.slice(0, sep) : arg;
				if (portOnly) sshPort = suffix;
				const probe = await probeRemotePaths(remote);
				resolvedSsh = {
					remote,
					remoteCwd: (portOnly || sep < 0 ? probe.cwd : suffix).replace(/\/+$/, "") || "/",
					remoteHome: probe.home,
				};
				const shellLabel = isPowerShellRemote() ? " (PowerShell)" : "";
				ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}${shellLabel}`));
				ctx.ui.notify(`SSH mode: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}${shellLabel}`, "info");
				console.log(`[pi-web] SSH connected: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}${shellLabel}`);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				console.error(`[pi-web] SSH failed: ${detail}`);
				ctx.ui.notify(`SSH 连接失败（${detail}），已拒绝本地执行`, "error");
			}
		}
	});

	// 会话销毁时释放常驻连接
	pi.on("session_shutdown", () => {
		stopUpstream();
	});

	// user_bash 旁路同样清洗本地环境，SSH 时仍走远程
	pi.on("user_bash", (_event) => {
		const ssh = requireSsh();
		if (!ssh) return { operations: localBashOps };
		return { operations: remoteShellOps(ssh.remote, ssh.remoteCwd, sessionCwd) };
	});

	// 用远端路径覆盖提示词 cwd 段（pi >= 0.86 把它独立成 <cwd> 段，不再是一行文本）
	pi.on("before_agent_start", (event) => {
		const ssh = getSsh();
		// SDK 每轮从 base options 重建该字段，故必须每轮重设
		if (ssh) event.systemPromptOptions.cwd = ssh.remoteCwd;
	});
}
