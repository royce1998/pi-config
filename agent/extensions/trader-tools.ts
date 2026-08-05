import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const AGENT = "/home/ubuntu/alpaca-agent";
const PARAMS_PATH = join(AGENT, "strategy", "params.json");
const HEARTBEAT_PATH = join(AGENT, "state", "heartbeat.json");
const EXIT_PLAN_PATH = join(AGENT, "state", "exit-plan.json");
const LOGS_DIR = join(AGENT, "logs");
const VALIDATOR_PATH = join(AGENT, "bin", "validate-params.sh");
const PI_AGENT_DIR = join(homedir(), ".pi", "agent");
const JOURNAL_PATH = join(PI_AGENT_DIR, "alpaca-journal.jsonl");
const STRATEGY_PATH = join(PI_AGENT_DIR, "alpaca-strategy.json");
const VALID_KINDS = new Set(["thought", "observation", "decision", "trade", "alert", "error", "note"]);

function atomicJson(path: string, value: unknown, mode = 0o600): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
	chmodSync(tmp, mode);
	renameSync(tmp, path);
}

function appendJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

function parseJson(path: string, fallback: unknown): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return fallback;
	}
}

function readJsonlTail(path: string, limit: number): unknown[] {
	if (!existsSync(path)) return [];
	try {
		const size = statSync(path).size;
		const maxBytes = 1024 * 1024;
		let text: string;
		if (size > maxBytes) {
			const buffer = readFileSync(path);
			text = buffer.subarray(size - maxBytes).toString("utf8");
			const firstNewline = text.indexOf("\n");
			if (firstNewline >= 0) text = text.slice(firstNewline + 1);
		} else {
			text = readFileSync(path, "utf8");
		}
		const rows: unknown[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				rows.push(JSON.parse(line));
			} catch {
				/* malformed historical rows are ignored, never executed */
			}
		}
		return rows.slice(-limit);
	} catch {
		return [];
	}
}

function cleanText(value: unknown, max: number): string {
	return String(value ?? "").trim().slice(0, max);
}

function rejectPathArguments(params: Record<string, unknown>): void {
	for (const key of ["path", "file", "filename", "directory", "command"]) {
		if (key in params) throw new Error(`trader tools do not accept arbitrary ${key} arguments`);
	}
}

function sanitizeSymbols(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : [];
	return raw
		.map((item) => cleanText(item, 32).toUpperCase())
		.filter((item) => /^[A-Z0-9./_-]+$/.test(item))
		.slice(0, 20);
}

// Tolerate a model that passes a JSON object encoded as a string (a common
// tool-call marshalling quirk) rather than a literal object. Parse once; if it
// is still not a plain object the caller's own validation reports the error.
function coerceObject(input: unknown): unknown {
	if (typeof input === "string") {
		const trimmed = input.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				return JSON.parse(trimmed);
			} catch {
				return input;
			}
		}
	}
	return input;
}

function sanitizeStrategy(rawInput: unknown): Record<string, unknown> {
	const input = coerceObject(rawInput);
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new Error("strategy must be an object");
	}
	const value = input as Record<string, unknown>;
	const name = cleanText(value.name, 160);
	const thesis = cleanText(value.thesis, 4000);
	const stance = cleanText(value.stance, 160);
	if (!name || !thesis || !stance || !Array.isArray(value.signals)) {
		throw new Error("strategy requires non-empty name, thesis, stance, and a signals array");
	}
	const strings = (item: unknown, maxItems = 100): string[] =>
		(Array.isArray(item) ? item : []).map((entry) => cleanText(entry, 500)).filter(Boolean).slice(0, maxItems);
	const signals = value.signals.slice(0, 100).map((raw) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("each signal must be an object");
		const signal = raw as Record<string, unknown>;
		const score = Number(signal.score);
		return {
			name: cleanText(signal.name, 160) || "unnamed signal",
			symbol: cleanText(signal.symbol, 32) || null,
			value: typeof signal.value === "number" || typeof signal.value === "string" ? signal.value : null,
			score: Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : null,
			direction: cleanText(signal.direction, 32) || null,
			weight: Number.isFinite(Number(signal.weight)) ? Number(signal.weight) : null,
			state: cleanText(signal.state, 80) || null,
			note: cleanText(signal.note, 1000) || null,
			updated_at: new Date().toISOString(),
		};
	});
	return {
		name,
		thesis,
		stance,
		updated_at: new Date().toISOString(),
		horizon: cleanText(value.horizon, 160) || null,
		universe: strings(value.universe),
		rules: strings(value.rules),
		signals,
		targets: strings(value.targets),
		risk_notes: cleanText(value.risk_notes, 4000) || null,
	};
}

export default function traderTools(pi: ExtensionAPI) {
	const ok = (value: unknown) => ({
		content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
		details: {},
	});

	pi.registerTool({
		name: "trader_journal",
		label: "Trader journal",
		description: "Append a safe, structured observation or decision to the trading dashboard journal.",
		parameters: Type.Object({
			kind: Type.Union([...VALID_KINDS].map((kind) => Type.Literal(kind))),
			text: Type.String({ description: "Journal text (max 4000 characters)" }),
			symbols: Type.Optional(Type.String({ description: "Comma-separated symbols" })),
		}),
		async execute(_id, params) {
			rejectPathArguments(params as Record<string, unknown>);
			const kind = String(params.kind).toLowerCase();
			const text = cleanText(params.text, 4000);
			if (!VALID_KINDS.has(kind)) throw new Error(`unknown journal kind: ${kind}`);
			if (!text) throw new Error("refusing to post an empty journal entry");
			const entry = { ts: new Date().toISOString(), kind, text, symbols: sanitizeSymbols(params.symbols) };
			appendJson(JOURNAL_PATH, entry);
			return ok({ appended: true, entry });
		},
	});

	pi.registerTool({
		name: "trader_metric",
		label: "Trader metric",
		description: "Append one structured trading-action metric to today's scoped metrics file.",
		parameters: Type.Object({
			signal: Type.String(),
			symbol: Type.String(),
			side: Type.String(),
			qty_or_notional: Type.Any(),
			thesis: Type.String(),
			profile: Type.Union([Type.Literal("paper"), Type.Literal("live")]),
			result: Type.String(),
			primary_signal: Type.Optional(Type.String({ description: "The single dominant signal for attribution (from signal_weights keys)" })),
			expected_edge_bps: Type.Optional(Type.Number({ description: "Pre-trade expected edge in basis points, for calibration" })),
			expected_win_prob: Type.Optional(Type.Number({ description: "Pre-trade estimated win probability 0..1" })),
			predicted_holding_days: Type.Optional(Type.Number({ description: "Expected holding period in trading days" })),
			regime: Type.Optional(Type.String({ description: "Regime label at decision time (risk_on/neutral/risk_off)" })),
		}),
		async execute(_id, params) {
			rejectPathArguments(params as Record<string, unknown>);
			const profile = String(params.profile);
			if (profile !== "paper" && profile !== "live") throw new Error("profile must be paper or live");
			const finiteOrNull = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);
			const entry = {
				ts: new Date().toISOString(),
				signal: cleanText(params.signal, 120),
				symbol: cleanText(params.symbol, 32).toUpperCase(),
				side: cleanText(params.side, 32).toLowerCase(),
				qty_or_notional: typeof params.qty_or_notional === "number" ? params.qty_or_notional : cleanText(params.qty_or_notional, 120),
				thesis: cleanText(params.thesis, 2000),
				profile,
				result: cleanText(params.result, 1000),
				// Structured expected-outcome fields (B-19) so calibration is computable, not prose.
				primary_signal: cleanText(params.primary_signal, 120) || null,
				expected_edge_bps: finiteOrNull(params.expected_edge_bps),
				expected_win_prob: finiteOrNull(params.expected_win_prob),
				predicted_holding_days: finiteOrNull(params.predicted_holding_days),
				regime: cleanText(params.regime, 40) || null,
			};
			if (!entry.signal || !entry.thesis || !entry.result) throw new Error("signal, thesis, and result are required");
			const day = new Date().toISOString().slice(0, 10);
			const path = join(LOGS_DIR, `metrics-${day}.jsonl`);
			appendJson(path, entry);
			return ok({ appended: true, entry });
		},
	});

	pi.registerTool({
		name: "trader_history",
		label: "Trader history",
		description: "Read recent scoped trading metrics and dashboard journal entries for attribution.",
		parameters: Type.Object({ days: Type.Optional(Type.Number({ description: "Recent UTC metric days (default 5, max 30)" })) }),
		async execute(_id, params) {
			rejectPathArguments(params as Record<string, unknown>);
			const days = Math.max(1, Math.min(30, Math.round(Number(params.days ?? 5))));
			let files: string[] = [];
			try {
				files = readdirSync(LOGS_DIR)
					.filter((name) => /^metrics-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
					.sort()
					.slice(-days);
			} catch {
				/* no metrics yet */
			}
			const metrics = files.flatMap((name) => readJsonlTail(join(LOGS_DIR, name), 1000));
			return ok({ days, metric_files: files, metrics, journal: readJsonlTail(JOURNAL_PATH, 50) });
		},
	});

	pi.registerTool({
		name: "trader_status",
		label: "Trader status",
		description: "Read validated strategy parameters and heartbeat without exposing credentials or policy files.",
		parameters: Type.Object({}),
		async execute(_id, params) {
			rejectPathArguments(params as Record<string, unknown>);
			const day = new Date().toISOString().slice(0, 10);
			const metrics = readJsonlTail(join(LOGS_DIR, `metrics-${day}.jsonl`), 100000);
			return ok({ params: parseJson(PARAMS_PATH, null), heartbeat: parseJson(HEARTBEAT_PATH, null), today_metric_count: metrics.length });
		},
	});

	pi.registerTool({
		name: "trader_propose_params",
		label: "Propose trader parameters",
		description: "Atomically submit strategy parameters through hard clamping and validation. Cannot change live activation.",
		parameters: Type.Object({ params: Type.Any() }),
		async execute(_id, params) {
			rejectPathArguments(params as Record<string, unknown>);
			const proposed = coerceObject(params.params);
			if (!proposed || typeof proposed !== "object" || Array.isArray(proposed)) {
				throw new Error("params must be a JSON object");
			}
			const serialized = JSON.stringify(proposed);
			if (serialized.length > 100_000) throw new Error("parameter proposal is too large");
			const current = parseJson(PARAMS_PATH, {}) as Record<string, unknown>;
			const candidate = JSON.parse(serialized) as Record<string, unknown>;
			const currentLive = current.live && typeof current.live === "object" ? (current.live as Record<string, unknown>).enabled === true : false;
			candidate.live = candidate.live && typeof candidate.live === "object" ? candidate.live : {};
			(candidate.live as Record<string, unknown>).enabled = currentLive;

			mkdirSync(dirname(PARAMS_PATH), { recursive: true });
			const tmp = join(dirname(PARAMS_PATH), `.params-candidate-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
			writeFileSync(tmp, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
			chmodSync(tmp, 0o600);
			const validation = spawnSync(VALIDATOR_PATH, [tmp], { encoding: "utf8", timeout: 30_000 });
			if (validation.status !== 0 && validation.status !== 2) {
				rmSync(tmp, { force: true });
				throw new Error(`parameter validation failed: ${(validation.stderr || validation.stdout || "unknown error").slice(0, 1000)}`);
			}
			const finalParams = parseJson(tmp, null);
			if (!finalParams || typeof finalParams !== "object") {
				rmSync(tmp, { force: true });
				throw new Error("validator did not produce valid parameters");
			}
			chmodSync(tmp, 0o600);
			renameSync(tmp, PARAMS_PATH);
			const clamped = `${validation.stderr ?? ""}\n${validation.stdout ?? ""}`
				.split("\n")
				.filter((line) => line.includes("clamped "))
				.map((line) => line.replace(/^.*clamped /, ""));
			return ok({ accepted: true, clamped, params: finalParams, live_activation_preserved: currentLive });
		},
	});

	pi.registerTool({
		name: "trader_publish_strategy",
		label: "Publish trader strategy",
		description: "Validate and atomically publish the dashboard strategy to its one fixed path.",
		parameters: Type.Object({ strategy: Type.Any() }),
		async execute(_id, params) {
			rejectPathArguments(params as Record<string, unknown>);
			const strategy = sanitizeStrategy(params.strategy);
			atomicJson(STRATEGY_PATH, strategy);
			return ok({ published: true, name: strategy.name, signals: (strategy.signals as unknown[]).length });
		},
	});

	pi.registerTool({
		name: "trader_set_exit_plan",
		label: "Set exit plan",
		description:
			"Register per-position exit intents (stop, target, end-of-day flatten, close-before-expiry) so the deterministic guardian enforces them even if this agent crashes. Replaces the whole plan; send every current open position each cycle.",
		parameters: Type.Object({
			positions: Type.Array(
				Type.Object({
					symbol: Type.String(),
					profile: Type.Union([Type.Literal("paper"), Type.Literal("live")]),
					kind: Type.Optional(Type.Union([Type.Literal("core"), Type.Literal("tactical")])),
					close_by: Type.Optional(Type.Union([Type.Literal("eod"), Type.Literal("expiry"), Type.Literal("hold")])),
					stop_price: Type.Optional(Type.Number()),
					target_price: Type.Optional(Type.Number()),
					expiry_date: Type.Optional(Type.String()),
					note: Type.Optional(Type.String()),
				}),
			),
		}),
		async execute(_id, params) {
			rejectPathArguments(params as Record<string, unknown>);
			const raw = Array.isArray((params as { positions?: unknown }).positions)
				? ((params as { positions: unknown[] }).positions)
				: [];
			const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);
			const positions = raw.slice(0, 100).map((entry) => {
				const p = (entry ?? {}) as Record<string, unknown>;
				const symbol = cleanText(p.symbol, 32).toUpperCase();
				if (!symbol) throw new Error("each exit-plan position needs a symbol");
				const profile = String(p.profile) === "live" ? "live" : "paper";
				const kind = p.kind === "tactical" ? "tactical" : "core";
				const close_by = ["eod", "expiry", "hold"].includes(String(p.close_by))
					? String(p.close_by)
					: kind === "tactical"
						? "eod"
						: "hold";
				return {
					symbol,
					profile,
					kind,
					close_by,
					stop_price: num(p.stop_price),
					target_price: num(p.target_price),
					expiry_date: cleanText(p.expiry_date, 16) || null,
					note: cleanText(p.note, 300) || null,
					updated_at: new Date().toISOString(),
				};
			});
			atomicJson(EXIT_PLAN_PATH, { updated_at: new Date().toISOString(), positions });
			return ok({ saved: true, count: positions.length });
		},
	});
}
