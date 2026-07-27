/**
 * supervisor — run another pi agent to completion.
 *
 * Launches a child `pi` process in RPC mode and keeps re-prompting it until a
 * measurable goal is reached. This is how one pi session can make another pi
 * agent "not stop until the job is done": the child agent settles after each
 * turn, the supervisor checks a progress command, and if the target isn't met
 * it nudges the worker to continue — looping until success, a stall (blocker),
 * or a safety cap.
 *
 * Why RPC (not one-shot `-p`): the worker keeps ONE persistent session, so its
 * context (what it already applied to, what it learned) carries across rounds.
 *
 * The worker inherits the same user-level extensions/skills as the parent
 * (e.g. the `browser` tools and the `job-search` skill), so it can drive a
 * browser and apply to jobs on its own.
 *
 * Concurrency note: the `browser` extension drives ONE Chrome profile per
 * process. Give the worker its own profile via `browserProfileDir` (sets
 * PI_BROWSER_PROFILE_DIR) if the parent is also using a browser.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Expand a leading ~ and resolve to an absolute path. */
function resolveDir(p: string): string {
	let s = p.trim();
	if (s === "~") s = os.homedir();
	else if (s.startsWith("~/") || s.startsWith("~\\")) s = path.join(os.homedir(), s.slice(2));
	return path.resolve(s);
}

// ---------------------------------------------------------------------------
// Shell resolution for the progress command (bash preferred; commands like
// `grep -c ...` need a POSIX shell even on Windows/Git-Bash environments).
// ---------------------------------------------------------------------------
let cachedShell: { cmd: string; flag: string } | null = null;
function resolveShell(): { cmd: string; flag: string } {
	if (cachedShell) return cachedShell;
	for (const cmd of ["bash", "sh"]) {
		try {
			const r = spawnSync(cmd, ["-c", "exit 0"], { stdio: "ignore" });
			if (!r.error) {
				cachedShell = { cmd, flag: "-c" };
				return cachedShell;
			}
		} catch {
			/* try next */
		}
	}
	// Last resort: platform default shell.
	cachedShell = process.platform === "win32" ? { cmd: "cmd.exe", flag: "/c" } : { cmd: "sh", flag: "-c" };
	return cachedShell;
}

/** Run a shell command, return the first integer found on stdout. */
function runProgress(command: string, cwd: string): Promise<{ ok: boolean; value: number; raw: string }> {
	return new Promise((resolve) => {
		const sh = resolveShell();
		const proc = spawn(sh.cmd, [sh.flag, command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		proc.stdout.on("data", (d) => (out += d.toString()));
		proc.stderr.on("data", (d) => (err += d.toString()));
		proc.on("error", () => resolve({ ok: false, value: NaN, raw: `spawn error: ${err}` }));
		proc.on("close", () => {
			const m = out.match(/-?\d+/);
			if (m) resolve({ ok: true, value: parseInt(m[0], 10), raw: out.trim() });
			else resolve({ ok: false, value: NaN, raw: (out || err).trim() });
		});
	});
}

// ---------------------------------------------------------------------------
// Resolve how to invoke pi (mirrors the subagent example: prefer this very
// pi script under the current runtime, fall back to `pi` on PATH).
// ---------------------------------------------------------------------------
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

// ---------------------------------------------------------------------------
// A thin RPC client over a child pi process (JSONL framing per docs/rpc.md:
// split on \n only, strip a trailing \r; never use readline).
// ---------------------------------------------------------------------------
type RpcEvent = Record<string, any>;

class RpcWorker {
	private proc: ChildProcess;
	private buffer = "";
	private waiters: Array<{ pred: (e: RpcEvent) => boolean; resolve: (e: RpcEvent) => void }> = [];
	closed = false;
	exitCode: number | null = null;
	stderrTail = "";
	dialogCount = 0;
	lastNotify = "";
	private onDialog: (e: RpcEvent) => void;

	constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, onDialog: (e: RpcEvent) => void) {
		this.onDialog = onDialog;
		this.proc = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		this.proc.stdout!.on("data", (d) => {
			this.buffer += d.toString();
			let idx: number;
			while ((idx = this.buffer.indexOf("\n")) !== -1) {
				let line = this.buffer.slice(0, idx);
				this.buffer = this.buffer.slice(idx + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				this.onLine(line);
			}
		});
		this.proc.stderr!.on("data", (d) => {
			this.stderrTail = (this.stderrTail + d.toString()).slice(-4000);
		});
		this.proc.on("close", (code) => {
			this.closed = true;
			this.exitCode = code ?? 0;
			// Wake any pending waiters so callers don't hang forever.
			const pending = this.waiters.splice(0);
			for (const w of pending) w.resolve({ type: "__closed__" });
		});
		this.proc.on("error", () => {
			this.closed = true;
			this.exitCode = this.exitCode ?? 1;
			const pending = this.waiters.splice(0);
			for (const w of pending) w.resolve({ type: "__closed__" });
		});
	}

	private onLine(line: string) {
		if (!line.trim()) return;
		let ev: RpcEvent;
		try {
			ev = JSON.parse(line);
		} catch {
			return;
		}
		// Auto-handle extension UI so the worker can never block the loop.
		if (ev.type === "extension_ui_request") {
			const dialog = ["select", "confirm", "input", "editor"].includes(ev.method);
			if (dialog) {
				this.dialogCount++;
				this.onDialog(ev);
				// Cancel dialogs: the worker's own extension decides what cancel means.
				this.send({ type: "extension_ui_response", id: ev.id, cancelled: true });
			} else if (ev.method === "notify" && typeof ev.message === "string") {
				this.lastNotify = ev.message;
			}
			return;
		}
		for (let i = this.waiters.length - 1; i >= 0; i--) {
			if (this.waiters[i].pred(ev)) {
				const [w] = this.waiters.splice(i, 1);
				w.resolve(ev);
			}
		}
	}

	send(obj: RpcEvent) {
		if (this.closed || !this.proc.stdin!.writable) return;
		this.proc.stdin!.write(JSON.stringify(obj) + "\n");
	}

	/** Resolve on the next event matching pred, on close, or on timeout. */
	waitFor(pred: (e: RpcEvent) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<RpcEvent> {
		if (this.closed) return Promise.resolve({ type: "__closed__" });
		return new Promise((resolve) => {
			const waiter = { pred, resolve: (e: RpcEvent) => finish(e) };
			let done = false;
			const finish = (e: RpcEvent) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				if (signal) signal.removeEventListener("abort", onAbort);
				const i = this.waiters.indexOf(waiter);
				if (i !== -1) this.waiters.splice(i, 1);
				resolve(e);
			};
			const onAbort = () => finish({ type: "__aborted__" });
			const timer = setTimeout(() => finish({ type: "__timeout__" }), timeoutMs);
			if (signal) {
				if (signal.aborted) return finish({ type: "__aborted__" });
				signal.addEventListener("abort", onAbort, { once: true });
			}
			this.waiters.push(waiter);
		});
	}

	kill() {
		try {
			this.send({ type: "abort" });
		} catch {
			/* ignore */
		}
		try {
			this.proc.stdin!.end();
		} catch {
			/* ignore */
		}
		try {
			this.proc.kill("SIGTERM");
		} catch {
			/* ignore */
		}
		setTimeout(() => {
			try {
				if (!this.proc.killed) this.proc.kill("SIGKILL");
			} catch {
				/* ignore */
			}
		}, 4000);
	}
}

// ---------------------------------------------------------------------------
// Core supervise loop.
// ---------------------------------------------------------------------------
interface SuperviseParams {
	task: string;
	progressCommand: string;
	target: number;
	cwd?: string;
	model?: string;
	nudge?: string;
	maxCycles?: number;
	stallLimit?: number;
	cycleTimeoutMs?: number;
	sessionName?: string;
	resume?: string;
	saveSession?: boolean;
	browserProfileDir?: string;
}

interface CycleRecord {
	cycle: number;
	count: number;
	delta: number;
	stopReason?: string;
	dialogs: number;
	note?: string;
}

interface SuperviseResult {
	outcome: "reached" | "stalled" | "max-cycles" | "worker-exited" | "aborted" | "bad-progress-command";
	startCount: number;
	finalCount: number;
	target: number;
	cyclesRun: number;
	records: CycleRecord[];
	workerExitCode: number | null;
	stderrTail: string;
	message: string;
}

async function supervise(
	params: SuperviseParams,
	defaultCwd: string,
	report: (line: string, records: CycleRecord[]) => void,
	signal?: AbortSignal,
): Promise<SuperviseResult> {
	const cwd = params.cwd ? resolveDir(params.cwd) : defaultCwd;
	if (!fs.existsSync(cwd)) {
		return {
			outcome: "bad-progress-command",
			startCount: NaN,
			finalCount: NaN,
			target: params.target,
			cyclesRun: 0,
			records: [],
			workerExitCode: null,
			stderrTail: "",
			message: `cwd does not exist: ${cwd}`,
		};
	}
	const maxCycles = Math.max(1, params.maxCycles ?? 40);
	const stallLimit = Math.max(1, params.stallLimit ?? 4);
	const cycleTimeoutMs = Math.max(30_000, params.cycleTimeoutMs ?? 900_000);
	const nudge =
		params.nudge ??
		"Continue toward the goal. Do NOT stop or ask for confirmation — keep going until the goal is fully met. If you hit a hard blocker that only a human can clear, note it and move on to the next item.";

	const records: CycleRecord[] = [];

	// Baseline progress check (also validates the progress command).
	const start = await runProgress(params.progressCommand, cwd);
	if (!start.ok) {
		return {
			outcome: "bad-progress-command",
			startCount: NaN,
			finalCount: NaN,
			target: params.target,
			cyclesRun: 0,
			records,
			workerExitCode: null,
			stderrTail: "",
			message: `progressCommand did not print a number. Output: ${start.raw || "(empty)"}`,
		};
	}
	if (start.value >= params.target) {
		return {
			outcome: "reached",
			startCount: start.value,
			finalCount: start.value,
			target: params.target,
			cyclesRun: 0,
			records,
			workerExitCode: null,
			stderrTail: "",
			message: `Already at goal (${start.value}/${params.target}) before starting.`,
		};
	}

	// Build the worker invocation.
	const rpcArgs = ["--mode", "rpc"];
	if (!(params.saveSession === false)) {
		// persistent session (default). resume takes an explicit session.
		if (params.resume) rpcArgs.push("--session", params.resume);
	} else {
		rpcArgs.push("--no-session");
	}
	if (params.model) rpcArgs.push("--model", params.model);
	if (params.sessionName) rpcArgs.push("--name", params.sessionName);
	const invocation = getPiInvocation(rpcArgs);

	const env: NodeJS.ProcessEnv = { ...process.env };
	if (params.browserProfileDir) env.PI_BROWSER_PROFILE_DIR = resolveDir(params.browserProfileDir);

	let lastDialog = "";
	const worker = new RpcWorker(invocation.command, invocation.args, cwd, env, (e) => {
		lastDialog = `${e.method}: ${e.title ?? e.message ?? ""}`.slice(0, 200);
	});

	const goalLine = `GOAL: keep working until \`${params.progressCommand}\` reports ${params.target} (currently ${start.value}).`;
	const firstMessage = `${params.task}\n\n${goalLine}`;

	let outcome: SuperviseResult["outcome"] = "max-cycles";
	let lastCount = start.value;
	let stall = 0;
	let cyclesRun = 0;

	try {
		for (let cycle = 1; cycle <= maxCycles; cycle++) {
			if (signal?.aborted) {
				outcome = "aborted";
				break;
			}

			// Send work for this round. Agent is idle here (first round, or just
			// settled), so a plain prompt is accepted.
			worker.send({ type: "prompt", message: cycle === 1 ? firstMessage : nudge });

			// Wait for the worker to fully settle (or exit/timeout/abort).
			const settleEv = await worker.waitFor(
				(e) => e.type === "agent_settled" || e.type === "__closed__" || e.type === "__timeout__" || e.type === "__aborted__",
				cycleTimeoutMs,
				signal,
			);
			cyclesRun = cycle;

			const dialogsThisRound = worker.dialogCount;
			worker.dialogCount = 0;

			if (settleEv.type === "__aborted__") {
				outcome = "aborted";
				break;
			}

			const progress = await runProgress(params.progressCommand, cwd);
			const count = progress.ok ? progress.value : lastCount;
			const delta = count - lastCount;
			const rec: CycleRecord = {
				cycle,
				count,
				delta,
				dialogs: dialogsThisRound,
				note:
					settleEv.type === "__timeout__"
						? "cycle timed out"
						: settleEv.type === "__closed__"
							? "worker process exited"
							: lastDialog
								? `dialog auto-cancelled → ${lastDialog}`
								: undefined,
			};
			records.push(rec);
			lastDialog = "";
			report(
				`cycle ${cycle}/${maxCycles} · ${count}/${params.target}` +
					(delta ? ` (+${delta})` : " (no progress)") +
					(rec.note ? ` · ${rec.note}` : ""),
				records,
			);

			if (count >= params.target) {
				outcome = "reached";
				lastCount = count;
				break;
			}
			if (settleEv.type === "__closed__") {
				outcome = "worker-exited";
				lastCount = count;
				break;
			}

			if (delta <= 0) stall++;
			else stall = 0;
			lastCount = count;

			if (stall >= stallLimit) {
				outcome = "stalled";
				break;
			}
			if (cycle >= maxCycles) {
				outcome = "max-cycles";
				break;
			}
		}
	} finally {
		worker.kill();
	}

	const messages: Record<SuperviseResult["outcome"], string> = {
		reached: `Goal reached: ${lastCount}/${params.target} after ${cyclesRun} cycle(s).`,
		stalled: `Stopped: no progress for ${stallLimit} consecutive cycle(s) — likely a human-only blocker (e.g. email verification / CAPTCHA / an AI-attestation gate). Reached ${lastCount}/${params.target}.`,
		"max-cycles": `Hit max cycles (${maxCycles}) at ${lastCount}/${params.target}. Re-run to continue.`,
		"worker-exited": `Worker process exited early at ${lastCount}/${params.target}. See stderr tail.`,
		aborted: `Aborted at ${lastCount}/${params.target}.`,
		"bad-progress-command": "progress command failed",
	};

	return {
		outcome,
		startCount: start.value,
		finalCount: lastCount,
		target: params.target,
		cyclesRun,
		records,
		workerExitCode: worker.exitCode,
		stderrTail: worker.stderrTail.slice(-1500),
		message: messages[outcome],
	};
}

function summarize(r: SuperviseResult): string {
	const lines: string[] = [];
	lines.push(r.message);
	lines.push("");
	lines.push(`Progress: ${r.startCount} → ${r.finalCount} / ${r.target} (${r.cyclesRun} cycle(s), outcome: ${r.outcome})`);
	if (r.records.length) {
		lines.push("");
		lines.push("Per-cycle:");
		for (const rec of r.records) {
			lines.push(
				`  ${rec.cycle}. ${rec.count}/${r.target}` +
					(rec.delta ? ` (+${rec.delta})` : " (+0)") +
					(rec.dialogs ? ` · ${rec.dialogs} dialog(s) auto-cancelled` : "") +
					(rec.note ? ` · ${rec.note}` : ""),
			);
		}
	}
	if ((r.outcome === "worker-exited" || r.outcome === "bad-progress-command") && r.stderrTail) {
		lines.push("");
		lines.push("Worker stderr (tail):");
		lines.push(r.stderrTail);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Parallel supervision: run N isolated workers at once, aggregated toward a
// shared target. Each worker gets its OWN Chrome profile dir (via
// PI_BROWSER_PROFILE_DIR) so they never collide on Chrome's per-profile
// singleton lock — the thing that otherwise makes only one browser work.
// ---------------------------------------------------------------------------
interface ParallelParams {
	task?: string;
	shards: string[];
	progressCommand: string;
	target: number;
	cwd?: string;
	model?: string;
	nudge?: string;
	maxCycles?: number;
	stallLimit?: number;
	cycleTimeoutMs?: number;
	saveSession?: boolean;
	sessionName?: string;
	profileBaseDir?: string;
	staggerMs?: number;
}

interface WorkerOutcome {
	worker: number;
	profileDir: string;
	result: SuperviseResult;
}

interface ParallelResult {
	outcome: "reached" | "stalled" | "exhausted" | "aborted" | "bad-progress-command";
	workers: number;
	startCount: number;
	finalCount: number;
	target: number;
	perWorker: WorkerOutcome[];
	message: string;
}

/** Merge parent signal + a group controller into one signal per worker. */
function linkAbort(parent: AbortSignal | undefined, group: AbortController): AbortController {
	const c = new AbortController();
	const onAbort = () => c.abort();
	if (parent) {
		if (parent.aborted) c.abort();
		else parent.addEventListener("abort", onAbort, { once: true });
	}
	if (group.signal.aborted) c.abort();
	else group.signal.addEventListener("abort", onAbort, { once: true });
	return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n: number) => String(n).padStart(2, "0");

async function superviseParallel(
	pp: ParallelParams,
	defaultCwd: string,
	report: (line: string) => void,
	signal?: AbortSignal,
): Promise<ParallelResult> {
	const cwd = pp.cwd ? resolveDir(pp.cwd) : defaultCwd;
	if (!fs.existsSync(cwd)) {
		return {
			outcome: "bad-progress-command",
			workers: 0,
			startCount: NaN,
			finalCount: NaN,
			target: pp.target,
			perWorker: [],
			message: `cwd does not exist: ${cwd}`,
		};
	}
	const shards = pp.shards.filter((s) => typeof s === "string");
	const n = Math.max(1, Math.min(10, shards.length));
	const profileBase = pp.profileBaseDir ? resolveDir(pp.profileBaseDir) : path.join(cwd, ".parallel-profiles");
	const staggerMs = Math.max(0, pp.staggerMs ?? 4000);

	const base = await runProgress(pp.progressCommand, cwd);
	if (!base.ok) {
		return {
			outcome: "bad-progress-command",
			workers: n,
			startCount: NaN,
			finalCount: NaN,
			target: pp.target,
			perWorker: [],
			message: `progressCommand did not print a number. Output: ${base.raw || "(empty)"}`,
		};
	}
	if (base.value >= pp.target) {
		return {
			outcome: "reached",
			workers: n,
			startCount: base.value,
			finalCount: base.value,
			target: pp.target,
			perWorker: [],
			message: `Already at goal (${base.value}/${pp.target}) before starting.`,
		};
	}

	const group = new AbortController();
	const latest: number[] = new Array(n).fill(base.value);
	const pushStatus = () => {
		const g = Math.max(base.value, ...latest);
		report(`${n} workers · ${g}/${pp.target} global`);
	};

	const promises: Array<Promise<WorkerOutcome>> = [];
	for (let i = 0; i < n; i++) {
		if (signal?.aborted || group.signal.aborted) break;
		const workerNo = i + 1;
		const profileDir = path.join(profileBase, `worker-${pad2(workerNo)}`);
		fs.mkdirSync(profileDir, { recursive: true });
		const wTask = `${pp.task ? pp.task + "\n\n" : ""}You are parallel worker ${workerNo} of ${n}. Work ONLY your assigned slice below; do not touch other workers' slices. Re-read the shared tracker first and skip anything already applied by ANY worker.\n\nYOUR SLICE:\n${shards[i]}`;
		const wc = linkAbort(signal, group);
		const wParams: SuperviseParams = {
			task: wTask,
			progressCommand: pp.progressCommand,
			target: pp.target,
			cwd,
			model: pp.model,
			nudge: pp.nudge,
			maxCycles: pp.maxCycles,
			stallLimit: pp.stallLimit,
			cycleTimeoutMs: pp.cycleTimeoutMs,
			sessionName: pp.sessionName ? `${pp.sessionName}-w${pad2(workerNo)}` : `parallel-w${pad2(workerNo)}`,
			saveSession: pp.saveSession,
			browserProfileDir: profileDir,
		};
		const p = supervise(
			wParams,
			cwd,
			(line, _recs) => {
				const m = line.match(/·\s*(\d+)\//);
				if (m) latest[i] = parseInt(m[1], 10);
				report(`[w${pad2(workerNo)}] ${line}`);
				pushStatus();
			},
			wc.signal,
		).then((result) => {
			// First worker to hit the shared target stops the whole group.
			if (result.outcome === "reached") group.abort();
			return { worker: workerNo, profileDir, result } as WorkerOutcome;
		});
		promises.push(p);
		report(`launched worker ${workerNo}/${n} (profile: ${profileDir})`);
		if (i < n - 1) await sleep(staggerMs);
	}

	const perWorker = await Promise.all(promises);
	const final = await runProgress(pp.progressCommand, cwd);
	const finalCount = final.ok ? final.value : Math.max(base.value, ...latest);

	let outcome: ParallelResult["outcome"];
	if (finalCount >= pp.target) outcome = "reached";
	else if (signal?.aborted) outcome = "aborted";
	else if (perWorker.every((w) => w.result.outcome === "stalled")) outcome = "stalled";
	else outcome = "exhausted";

	const msg: Record<ParallelResult["outcome"], string> = {
		reached: `Goal reached across ${n} workers: ${finalCount}/${pp.target}.`,
		stalled: `All ${n} workers stalled at ${finalCount}/${pp.target} — remaining work likely needs a human (email verification / CAPTCHA / AI attestation).`,
		exhausted: `Workers finished (max-cycles/exit) at ${finalCount}/${pp.target}. Re-run to continue.`,
		aborted: `Aborted at ${finalCount}/${pp.target}.`,
		"bad-progress-command": "progress command failed",
	};

	return {
		outcome,
		workers: n,
		startCount: base.value,
		finalCount,
		target: pp.target,
		perWorker,
		message: msg[outcome],
	};
}

function summarizeParallel(r: ParallelResult): string {
	const lines: string[] = [r.message, ""];
	lines.push(`Global: ${r.startCount} → ${r.finalCount} / ${r.target} across ${r.workers} worker(s) (outcome: ${r.outcome}).`);
	if (r.perWorker.length) {
		lines.push("");
		lines.push("Per-worker:");
		for (const w of r.perWorker) {
			lines.push(`  w${pad2(w.worker)}: ${w.result.outcome} · ${w.result.cyclesRun} cycle(s) · ${w.result.message}`);
		}
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension registration.
// ---------------------------------------------------------------------------
export default function supervisorExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "supervise_agent",
		label: "Supervise Agent",
		description:
			"Launch another pi agent as a child process (RPC mode) and keep re-prompting it until a measurable goal is reached. " +
			"Use this to run an agent autonomously to completion — it will not stop until the progress command reports the target, " +
			"a stall (human-only blocker) is detected, or a safety cap is hit. The worker keeps ONE persistent session so its context " +
			"carries across rounds, and it inherits the same skills/extensions as this session (e.g. browser tools, job-search skill).",
		promptSnippet: "Run another pi agent in a loop until a goal count is reached (progressCommand hits target).",
		promptGuidelines: [
			"Use supervise_agent when the user wants another agent/session to keep going until N things are done (e.g. 'apply to 50 jobs, don't stop').",
			"For supervise_agent, progressCommand must print the current count as an integer (e.g. a grep -c over a tracker file) and cwd should be where that file lives.",
			"For supervise_agent, if the parent is also using the browser, pass browserProfileDir so the worker drives its own Chrome profile.",
		],
		parameters: Type.Object({
			task: Type.String({
				description:
					"Full instruction handed to the worker on the first round: what to do, where the tracker/profile files are, and the rules to follow.",
			}),
			progressCommand: Type.String({
				description:
					"Shell command whose stdout's first integer is the current progress count (e.g. \"grep -c '| Applied |' applications.md\"). Run in cwd.",
			}),
			target: Type.Number({ description: "Loop until the progress count is >= this value." }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the worker + progress command. Default: this session's cwd." })),
			model: Type.Optional(Type.String({ description: "Model pattern for the worker (default: your configured default model)." })),
			nudge: Type.Optional(Type.String({ description: "Message sent each round after the first to make the worker continue." })),
			maxCycles: Type.Optional(Type.Number({ description: "Safety cap on rounds (default 40)." })),
			stallLimit: Type.Optional(Type.Number({ description: "Stop after this many consecutive no-progress rounds (default 4)." })),
			cycleTimeoutMs: Type.Optional(Type.Number({ description: "Max ms to wait for one round to settle (default 900000)." })),
			sessionName: Type.Optional(Type.String({ description: "Display name for the worker session." })),
			resume: Type.Optional(Type.String({ description: "Session id or path to continue an existing worker session instead of starting fresh." })),
			saveSession: Type.Optional(Type.Boolean({ description: "Persist the worker session (default true). Set false for ephemeral." })),
			browserProfileDir: Type.Optional(
				Type.String({ description: "Sets PI_BROWSER_PROFILE_DIR for the worker so it drives its own Chrome profile." }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const p = params as unknown as SuperviseParams;
			const defaultCwd = (ctx as any)?.cwd || process.cwd();

			const report = (line: string, records: CycleRecord[]) => {
				try {
					ctx?.ui?.setStatus?.("supervisor", `supervise: ${line}`);
				} catch {
					/* ignore */
				}
				onUpdate?.({
					content: [{ type: "text", text: `Supervising worker…\n${line}` }],
					details: { records },
				});
			};

			report("starting worker…", []);
			const result = await supervise(p, defaultCwd, report, signal);
			try {
				ctx?.ui?.setStatus?.("supervisor", undefined);
			} catch {
				/* ignore */
			}

			return {
				content: [{ type: "text", text: summarize(result) }],
				details: result as any,
				isError: result.outcome === "bad-progress-command" || result.outcome === "worker-exited",
			};
		},
	});

	// Human convenience: /supervise {json}
	pi.registerCommand("supervise", {
		description: "Run a worker agent until a goal. Arg: JSON like {\"task\":\"...\",\"progressCommand\":\"grep -c X f\",\"target\":50,\"cwd\":\"...\"}",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			if (!raw) {
				ctx.ui.notify(
					'Usage: /supervise {"task":"…","progressCommand":"grep -c \'| Applied |\' applications.md","target":50,"cwd":"~/.pi/agent/job-search/arthur"}',
					"info",
				);
				return;
			}
			let p: SuperviseParams;
			try {
				p = JSON.parse(raw);
			} catch (e) {
				ctx.ui.notify(`Could not parse JSON arg: ${(e as Error).message}`, "error");
				return;
			}
			if (!p.task || !p.progressCommand || typeof p.target !== "number") {
				ctx.ui.notify("JSON must include task (string), progressCommand (string), target (number).", "error");
				return;
			}
			const defaultCwd = (ctx as any)?.cwd || process.cwd();
			ctx.ui.notify(`Supervising worker toward ${p.target}…`, "info");
			const result = await supervise(
				p,
				defaultCwd,
				(line) => {
					try {
						ctx.ui.setStatus("supervisor", `supervise: ${line}`);
					} catch {
						/* ignore */
					}
				},
				undefined,
			);
			try {
				ctx.ui.setStatus("supervisor", undefined);
			} catch {
				/* ignore */
			}
			ctx.ui.notify(result.message, result.outcome === "reached" ? "info" : "warning");
			pi.sendMessage(
				{ customType: "supervisor", content: summarize(result), display: true, details: result as any },
				{ deliverAs: "nextTurn" },
			);
		},
	});

	// -----------------------------------------------------------------------
	// Parallel launcher: many isolated workers at once.
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "parallel_apply",
		label: "Parallel Agents",
		description:
			"Spin up MULTIPLE pi worker agents in parallel (each in its own child process with its OWN Chrome profile) and " +
			"supervise them together until a shared progress goal is reached. Use this to parallelize browser work like job " +
			"applications: give one shard string per worker (a disjoint slice of the work) and a progressCommand that counts " +
			"GLOBAL progress across the shared tracker. Each worker gets a unique PI_BROWSER_PROFILE_DIR so they never collide " +
			"on Chrome's per-profile singleton lock.",
		promptSnippet: "Run several pi worker agents in parallel (isolated browser profiles) until a shared goal is met.",
		promptGuidelines: [
			"Use parallel_apply when the user wants multiple agents applying to jobs (or doing browser work) at the SAME time.",
			"For parallel_apply, give disjoint shards (e.g. non-overlapping company lists) so workers never double-apply, and make progressCommand count global progress across all workers' tracker rows.",
		],
		parameters: Type.Object({
			shards: Type.Array(Type.String(), {
				description: "One entry per worker: a disjoint slice of work (e.g. the companies/roles that worker owns). Worker count = shards.length (max 10).",
			}),
			progressCommand: Type.String({ description: "Command whose stdout's first integer is GLOBAL progress across all workers (e.g. count Applied rows across trackers)." }),
			target: Type.Number({ description: "Loop until global count >= this value." }),
			task: Type.Optional(Type.String({ description: "Shared instruction prepended to every worker's shard (rules, file locations, how to record submissions)." })),
			cwd: Type.Optional(Type.String({ description: "Working dir for workers + progress command (~ expanded). Default: session cwd." })),
			model: Type.Optional(Type.String({ description: "Model pattern for the workers." })),
			nudge: Type.Optional(Type.String({ description: "Per-round continue message." })),
			maxCycles: Type.Optional(Type.Number({ description: "Per-worker round cap (default 40)." })),
			stallLimit: Type.Optional(Type.Number({ description: "Per-worker consecutive no-progress rounds before it stops (default 4)." })),
			cycleTimeoutMs: Type.Optional(Type.Number({ description: "Max ms to wait for one worker round (default 900000)." })),
			profileBaseDir: Type.Optional(Type.String({ description: "Base dir for per-worker Chrome profiles. Default: <cwd>/.parallel-profiles/worker-NN." })),
			staggerMs: Type.Optional(Type.Number({ description: "Delay between launching workers (default 4000) to avoid a thundering herd." })),
			sessionName: Type.Optional(Type.String({ description: "Base name for worker sessions (suffixed -wNN)." })),
			saveSession: Type.Optional(Type.Boolean({ description: "Persist worker sessions (default true)." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const pp = params as unknown as ParallelParams;
			const defaultCwd = (ctx as any)?.cwd || process.cwd();
			const log: string[] = [];
			const report = (line: string) => {
				log.push(line);
				try {
					ctx?.ui?.setStatus?.("supervisor", `parallel: ${line}`);
				} catch {
					/* ignore */
				}
				onUpdate?.({ content: [{ type: "text", text: `Parallel workers…\n${log.slice(-8).join("\n")}` }], details: {} });
			};
			report(`launching ${Math.min(10, (pp.shards || []).length)} worker(s)…`);
			const result = await superviseParallel(pp, defaultCwd, report, signal);
			try {
				ctx?.ui?.setStatus?.("supervisor", undefined);
			} catch {
				/* ignore */
			}
			return {
				content: [{ type: "text", text: summarizeParallel(result) }],
				details: result as any,
				isError: result.outcome === "bad-progress-command",
			};
		},
	});

	pi.registerCommand("parallel", {
		description: 'Run N worker agents in parallel until a shared goal. Arg: JSON {"shards":["…","…"],"progressCommand":"…","target":50,"cwd":"…"}',
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			if (!raw) {
				ctx.ui.notify('Usage: /parallel {"shards":["companies A-F","companies G-M"],"progressCommand":"…","target":50,"cwd":"…"}', "info");
				return;
			}
			let pp: ParallelParams;
			try {
				pp = JSON.parse(raw);
			} catch (e) {
				ctx.ui.notify(`Could not parse JSON arg: ${(e as Error).message}`, "error");
				return;
			}
			if (!Array.isArray(pp.shards) || !pp.shards.length || !pp.progressCommand || typeof pp.target !== "number") {
				ctx.ui.notify("JSON must include shards (non-empty array), progressCommand (string), target (number).", "error");
				return;
			}
			const defaultCwd = (ctx as any)?.cwd || process.cwd();
			ctx.ui.notify(`Launching ${Math.min(10, pp.shards.length)} parallel workers toward ${pp.target}…`, "info");
			const result = await superviseParallel(
				pp,
				defaultCwd,
				(line) => {
					try {
						ctx.ui.setStatus("supervisor", `parallel: ${line}`);
					} catch {
						/* ignore */
					}
				},
				undefined,
			);
			try {
				ctx.ui.setStatus("supervisor", undefined);
			} catch {
				/* ignore */
			}
			ctx.ui.notify(result.message, result.outcome === "reached" ? "info" : "warning");
			pi.sendMessage(
				{ customType: "supervisor", content: summarizeParallel(result), display: true, details: result as any },
				{ deliverAs: "nextTurn" },
			);
		},
	});
}
