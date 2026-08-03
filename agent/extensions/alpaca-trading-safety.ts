/**
 * Alpaca autonomous trading tools + risk gate for Pi.
 *
 * Install at ~/.pi/agent/extensions/alpaca-trading-safety.ts.
 *
 * MODE: autonomous. This gate does NOT ask the user to confirm orders. It
 * enforces a machine-checkable risk policy instead, so it works headlessly
 * (Telegram bridge, cron, -p) where no interactive UI exists.
 *
 * Control surface:
 *   ~/.pi/agent/alpaca-policy.json       (edit to retune; `enabled: false` halts trading)
 *   ~/.pi/agent/alpaca-credentials.json  (API keys, mode 600, never committed)
 *   ~/.pi/agent/alpaca-audit.jsonl       (every decision, allowed or denied)
 *   ~/.pi/agent/alpaca-ledger-<profile>.json (per-account spend/count ledger)
 *
 * Unlike the MCP-based predecessor, these tools are implemented here directly
 * against Alpaca's REST API, so the gate cannot be bypassed by calling an
 * upstream tool the gate does not recognise: there is no upstream.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const POLICY_PATH = join(AGENT_DIR, "alpaca-policy.json");
const AUDIT_PATH = join(AGENT_DIR, "alpaca-audit.jsonl");
const LEGACY_LEDGER_PATH = join(AGENT_DIR, "alpaca-ledger.json");
const CREDENTIALS_PATH = join(AGENT_DIR, "alpaca-credentials.json");
const DATA_BASE_URL = "https://data.alpaca.markets";
const CONTRACT_MULTIPLIER = 100;

/* ------------------------------------------------------------------ policy */

type Policy = {
	enabled: boolean;
	paperOnly: boolean;
	maxOrderNotional: number;
	maxDailyNotional: number;
	maxOrdersPerDay: number;
	maxOrdersPerHour: number;
	marketOrderMaxNotional: number;
	requireBoundedNotional: boolean;
	requireReview: boolean;
	reviewMaxAgeSeconds: number;
	duplicateWindowSeconds: number;
	allowOptions: boolean;
	allowShorting: boolean;
	allowCrypto: boolean;
	symbolAllowlist: string[];
	symbolBlocklist: string[];
	/**
	 * Per-credential-profile overrides, merged over the base policy by the name in
	 * alpaca-credentials.json. Without this, one set of caps sized for a large
	 * paper account would silently apply to a small live one - the caps would be
	 * larger than the account and enforce nothing.
	 */
	profileOverrides?: Record<string, Partial<Policy>>;
};

const DEFAULT_POLICY: Policy = {
	// Master switch. Set false to stop the agent trading without uninstalling anything.
	enabled: true,
	// Refuse to trade a non-paper account. Flipping this is a deliberate,
	// separate decision from any individual order.
	paperOnly: true,
	// Per-order and per-day caps, in dollars of notional.
	maxOrderNotional: 500,
	maxDailyNotional: 2000,
	// Count caps. maxOrdersPerHour is the runaway-loop brake.
	maxOrdersPerDay: 10,
	maxOrdersPerHour: 4,
	// Market orders can fill anywhere; keep them on a shorter leash than limits.
	marketOrderMaxNotional: 250,
	// Refuse orders whose worst-case cost cannot be computed. This is what stops
	// an unbounded market order.
	requireBoundedNotional: true,
	// Require alpaca_review_order for the same order first: an automated
	// pre-flight, not a human checkpoint.
	requireReview: true,
	reviewMaxAgeSeconds: 300,
	// Collapse identical re-submissions inside this window (retry-loop guard).
	duplicateWindowSeconds: 90,
	allowOptions: false,
	// Short selling has unbounded loss; opt in explicitly.
	allowShorting: false,
	allowCrypto: true,
	// Empty allowlist means "any symbol". Blocklist always wins.
	symbolAllowlist: [],
	symbolBlocklist: [],
	profileOverrides: {},
};

/**
 * Load the policy, merged with any overrides for the active credential profile.
 * Caps must always match the account they are pointed at, so the profile name is
 * part of the policy identity rather than an afterthought.
 */
function loadPolicy(profileName?: string): Policy {
	let base: Policy;
	try {
		const raw = JSON.parse(readFileSync(POLICY_PATH, "utf8")) as Partial<Policy>;
		base = { ...DEFAULT_POLICY, ...raw };
	} catch {
		try {
			mkdirSync(dirname(POLICY_PATH), { recursive: true });
			writeFileSync(POLICY_PATH, `${JSON.stringify(DEFAULT_POLICY, null, 2)}\n`, { mode: 0o600 });
		} catch {
			/* fall through to in-memory defaults */
		}
		base = { ...DEFAULT_POLICY };
	}

	const name = profileName ?? activeProfileName();
	const override = name ? base.profileOverrides?.[name] : undefined;
	return override ? { ...base, ...override } : base;
}

/* ------------------------------------------------------------------ ledger */

type Ledger = {
	day: string;
	dayNotional: number;
	dayOrders: number;
	recent: { ts: number; hash: string; notional: number }[];
	reviews: { ts: number; key: string }[];
};

const today = (): string => new Date().toISOString().slice(0, 10);

function ledgerPath(profile: string): string {
	// Profile names originate in the local credentials file, but sanitising here
	// prevents a malformed name from escaping AGENT_DIR.
	const safeProfile = profile.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
	return join(AGENT_DIR, `alpaca-ledger-${safeProfile}.json`);
}

function loadLedger(profile: string): Ledger {
	let ledger: Ledger;
	const path = ledgerPath(profile);
	try {
		// Backwards compatibility: the legacy unscoped ledger belonged to the
		// active paper profile. The first subsequent save writes the scoped file.
		const source = profile === "paper" && !existsSync(path) && existsSync(LEGACY_LEDGER_PATH)
			? LEGACY_LEDGER_PATH
			: path;
		ledger = JSON.parse(readFileSync(source, "utf8")) as Ledger;
	} catch {
		ledger = { day: today(), dayNotional: 0, dayOrders: 0, recent: [], reviews: [] };
	}
	if (ledger.day !== today()) {
		ledger.day = today();
		ledger.dayNotional = 0;
		ledger.dayOrders = 0;
	}
	const cutoff = Date.now() - 3600_000;
	ledger.recent = (ledger.recent ?? []).filter((entry) => entry.ts >= cutoff);
	ledger.reviews = (ledger.reviews ?? []).filter((entry) => entry.ts >= cutoff);
	return ledger;
}

function saveLedger(profile: string, ledger: Ledger): void {
	const path = ledgerPath(profile);
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, path);
	} catch {
		/* ledger is best-effort; never block trading on a disk hiccup */
	}
}

function audit(entry: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(AUDIT_PATH), { recursive: true });
		const { profile: suppliedProfile, ...rest } = entry;
		const profile = typeof suppliedProfile === "string" ? suppliedProfile : activeProfileName() ?? "unknown";
		appendFileSync(
			AUDIT_PATH,
			`${JSON.stringify({ ts: new Date().toISOString(), profile, ...rest })}\n`,
			{ mode: 0o600 },
		);
	} catch {
		/* auditing must never crash a turn */
	}
}

/* ------------------------------------------------------------- credentials */

type Credentials = {
	profileName: string;
	baseUrl: string;
	keyId: string;
	secretKey: string;
	paper: boolean;
};

function loadCredentials(profileName?: string): Credentials {
	let raw: {
		activeProfile?: string;
		profiles?: Record<string, { baseUrl?: string; keyId?: string; secretKey?: string; paper?: boolean }>;
	};
	try {
		raw = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
	} catch (error) {
		const reason = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unreadable";
		throw new Error(
			`Alpaca credentials are ${reason} at ${CREDENTIALS_PATH}. Run /alpaca-setup in Pi to configure them.`,
		);
	}
	const requested = profileName?.trim();
	const name = requested || raw.activeProfile || "paper";
	const profile = raw.profiles?.[name];
	if (!profile?.keyId || !profile?.secretKey || !profile?.baseUrl) {
		throw new Error(`Alpaca profile "${name}" is missing baseUrl, keyId or secretKey.`);
	}
	return {
		profileName: name,
		baseUrl: profile.baseUrl.replace(/\/+$/, ""),
		keyId: profile.keyId,
		secretKey: profile.secretKey,
		paper: profile.paper !== false,
	};
}

/** Active profile name, or undefined when credentials are unreadable. */
function activeProfileName(): string | undefined {
	try {
		return loadCredentials().profileName;
	} catch {
		return undefined;
	}
}

/** Resolve a requested profile without making review/audit paths throw on bad credentials. */
function resolveProfileName(profileName?: string): string {
	try {
		return loadCredentials(profileName).profileName;
	} catch {
		return profileName?.trim() || activeProfileName() || "paper";
	}
}

async function api(
	method: "GET" | "POST" | "PATCH" | "DELETE",
	path: string,
	{ body, params, dataApi = false, profile, signal }: {
		body?: unknown;
		params?: Record<string, string | number | boolean | undefined>;
		dataApi?: boolean;
		profile?: string;
		signal?: AbortSignal;
	} = {},
): Promise<unknown> {
	const credentials = loadCredentials(profile);
	const url = new URL((dataApi ? DATA_BASE_URL : credentials.baseUrl) + path);
	for (const [key, value] of Object.entries(params ?? {})) {
		if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
	}
	const response = await fetch(url, {
		method,
		headers: {
			"APCA-API-KEY-ID": credentials.keyId,
			"APCA-API-SECRET-KEY": credentials.secretKey,
			Accept: "application/json",
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal,
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Alpaca ${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
	}
	return text ? JSON.parse(text) : null;
}

/* --------------------------------------------------------------- utilities */

const isCrypto = (symbol: string): boolean => symbol.includes("/");
const isOption = (symbol: string): boolean =>
	/^[A-Z][A-Z0-9.]{0,5}\d{6}[CP]\d{8}$/.test(symbol.toUpperCase());

function num(value: unknown): number | undefined {
	const parsed = typeof value === "string" ? Number.parseFloat(value) : (value as number);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function money(value: number): string {
	return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A buffered lookback so Alpaca can return `limit` recent bars despite weekends/closures. */
function defaultBarsStart(timeframe: string, limit: number): string {
	const normalized = timeframe.toLowerCase();
	let days: number;
	if (normalized.endsWith("day")) {
		days = limit * 2 + 10;
	} else if (normalized.endsWith("hour")) {
		days = Math.ceil(limit / 6) + 5;
	} else {
		days = Math.max(10, Math.ceil(limit / 200) + 5);
	}
	return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Latest traded price, used to bound a market order's worst-case cost. */
async function latestPrice(symbol: string, signal?: AbortSignal): Promise<number | undefined> {
	try {
		if (isCrypto(symbol)) {
			const body = (await api("GET", "/v1beta3/crypto/us/latest/trades", {
				params: { symbols: symbol },
				dataApi: true,
				signal,
			})) as { trades?: Record<string, { p?: number }> };
			return num(body?.trades?.[symbol]?.p);
		}
		const body = (await api("GET", `/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`, {
			dataApi: true,
			signal,
		})) as { trade?: { p?: number } };
		return num(body?.trade?.p);
	} catch {
		return undefined;
	}
}

/** Long quantity currently held, 0 when there is no position. */
async function currentQty(symbol: string, signal?: AbortSignal, profile?: string): Promise<number> {
	try {
		const position = (await api("GET", `/v2/positions/${encodeURIComponent(symbol)}`, {
			profile,
			signal,
		})) as {
			qty?: string;
		};
		return num(position?.qty) ?? 0;
	} catch (error) {
		// Alpaca returns 404 for "no position", which is a valid answer of zero.
		if (/HTTP 404/.test((error as Error).message)) return 0;
		throw error;
	}
}

type OrderIntent = {
	symbol: string;
	side: "buy" | "sell";
	qty?: number;
	notional?: number;
	type: "market" | "limit" | "stop" | "stop_limit";
	limit_price?: number;
	stop_price?: number;
	time_in_force: string;
	extended_hours?: boolean;
};

function fingerprint(intent: OrderIntent): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				intent.symbol.toUpperCase(),
				intent.side,
				intent.qty ?? null,
				intent.notional ?? null,
				intent.type,
				intent.limit_price ?? null,
				intent.stop_price ?? null,
			]),
		)
		.digest("hex")
		.slice(0, 32);
}

/**
 * Worst-case dollar exposure of an order. `bounded` is false when it cannot be
 * computed at all, which `requireBoundedNotional` turns into a refusal.
 */
async function estimateNotional(
	intent: OrderIntent,
	signal?: AbortSignal,
): Promise<{ notional?: number; bounded: boolean; basis: string }> {
	if (isOption(intent.symbol)) {
		if (intent.notional !== undefined) {
			return {
				bounded: false,
				basis: "options must be sized by qty+limit_price, not notional",
			};
		}
		if (intent.qty === undefined) {
			return { bounded: false, basis: "option order requires qty and a limit price" };
		}
		if (intent.type === "limit" || intent.type === "stop_limit") {
			if (intent.limit_price === undefined) {
				return { bounded: false, basis: "option order requires a limit price" };
			}
			return {
				notional: intent.qty * intent.limit_price * CONTRACT_MULTIPLIER,
				bounded: true,
				basis: "qty x limit_price x100 (option)",
			};
		}
		if (intent.type === "stop" && intent.stop_price !== undefined) {
			return {
				notional: intent.qty * intent.stop_price * CONTRACT_MULTIPLIER,
				bounded: true,
				basis: "qty x stop_price x100 (option)",
			};
		}
		return {
			bounded: false,
			basis: "option order requires a limit price (market/naked-notional options refused)",
		};
	}
	if (intent.notional !== undefined) {
		return { notional: intent.notional, bounded: true, basis: "explicit notional" };
	}
	if (intent.qty === undefined) {
		return { bounded: false, basis: "neither qty nor notional supplied" };
	}
	if (intent.type === "limit" || intent.type === "stop_limit") {
		if (intent.limit_price === undefined) {
			return { bounded: false, basis: "limit order without limit_price" };
		}
		return { notional: intent.qty * intent.limit_price, bounded: true, basis: "qty x limit_price" };
	}
	if (intent.type === "stop" && intent.stop_price !== undefined) {
		return { notional: intent.qty * intent.stop_price, bounded: true, basis: "qty x stop_price" };
	}
	const price = await latestPrice(intent.symbol, signal);
	if (price === undefined) {
		return { bounded: false, basis: "market order and no live price available" };
	}
	return { notional: intent.qty * price, bounded: true, basis: "qty x last trade price (estimate)" };
}

/* -------------------------------------------------------------- the gate */

type Decision = { allowed: boolean; reasons: string[]; notional?: number; basis: string };

async function evaluate(intent: OrderIntent, signal?: AbortSignal, profileName?: string): Promise<Decision> {
	const reasons: string[] = [];
	const symbol = intent.symbol.toUpperCase();

	let credentials: Credentials | undefined;
	try {
		credentials = loadCredentials(profileName);
	} catch (error) {
		reasons.push((error as Error).message);
	}

	// Caps and usage are resolved against the profile actually being traded.
	const profile = credentials?.profileName ?? profileName?.trim() ?? activeProfileName() ?? "paper";
	const policy = loadPolicy(profile);
	const ledger = loadLedger(profile);

	if (!policy.enabled) reasons.push("Trading is halted (policy.enabled = false). Run /alpaca-safety.");
	if (policy.paperOnly && credentials && !credentials.paper) {
		reasons.push(
			`Policy allows paper trading only, but profile "${credentials.profileName}" is a live account.`,
		);
	}
	if (isOption(symbol) && !policy.allowOptions) {
		reasons.push("Options trading is disabled by policy.");
	}
	if (intent.side === "sell" && !policy.allowShorting) {
		// A sell beyond the current long position opens a short. Verify against the
		// actual position rather than trusting the broker to reject it.
		try {
			const held = await currentQty(intent.symbol, signal, profile);
			if (intent.qty !== undefined && held < intent.qty) {
				reasons.push(
					`Selling ${intent.qty} of ${symbol} against a position of ${held} would open a short, and allowShorting is false.`,
				);
			}
		} catch (error) {
			reasons.push(
				`Cannot verify the ${symbol} position to rule out a short (${(error as Error).message}); refusing while allowShorting is false.`,
			);
		}
	}

	if (policy.symbolBlocklist.map((s) => s.toUpperCase()).includes(symbol)) {
		reasons.push(`${symbol} is on the policy symbol blocklist.`);
	}
	if (
		policy.symbolAllowlist.length > 0 &&
		!policy.symbolAllowlist.map((s) => s.toUpperCase()).includes(symbol)
	) {
		reasons.push(`${symbol} is not on the policy symbol allowlist.`);
	}
	if (isCrypto(symbol) && !policy.allowCrypto) reasons.push("Crypto trading is disabled by policy.");

	const { notional, bounded, basis } = await estimateNotional(intent, signal);
	if (!bounded && policy.requireBoundedNotional) {
		reasons.push(`Cannot bound worst-case cost (${basis}); policy requires a bounded order.`);
	}
	if (notional !== undefined) {
		if (notional > policy.maxOrderNotional) {
			reasons.push(
				`Order notional ${money(notional)} exceeds maxOrderNotional ${money(policy.maxOrderNotional)}.`,
			);
		}
		if (intent.type === "market" && notional > policy.marketOrderMaxNotional) {
			reasons.push(
				`Market order ${money(notional)} exceeds marketOrderMaxNotional ${money(policy.marketOrderMaxNotional)}.`,
			);
		}
		if (ledger.dayNotional + notional > policy.maxDailyNotional) {
			reasons.push(
				`Would bring today's notional to ${money(ledger.dayNotional + notional)}, over maxDailyNotional ${money(policy.maxDailyNotional)}.`,
			);
		}
	}

	if (ledger.dayOrders >= policy.maxOrdersPerDay) {
		reasons.push(`Daily order count ${ledger.dayOrders}/${policy.maxOrdersPerDay} reached.`);
	}
	const lastHour = ledger.recent.filter((entry) => entry.ts >= Date.now() - 3600_000).length;
	if (lastHour >= policy.maxOrdersPerHour) {
		reasons.push(`Hourly order count ${lastHour}/${policy.maxOrdersPerHour} reached.`);
	}

	const hash = fingerprint(intent);
	const duplicate = ledger.recent.find(
		(entry) => entry.hash === hash && entry.ts >= Date.now() - policy.duplicateWindowSeconds * 1000,
	);
	if (duplicate) {
		reasons.push(
			`Identical order was submitted ${Math.round((Date.now() - duplicate.ts) / 1000)}s ago (duplicate window ${policy.duplicateWindowSeconds}s).`,
		);
	}

	if (policy.requireReview) {
		const reviewed = ledger.reviews.find(
			(entry) => entry.key === hash && entry.ts >= Date.now() - policy.reviewMaxAgeSeconds * 1000,
		);
		if (!reviewed) {
			reasons.push(
				`No alpaca_review_order within ${policy.reviewMaxAgeSeconds}s for this exact order. Review it first.`,
			);
		}
	}

	return { allowed: reasons.length === 0, reasons, notional, basis };
}

/* ------------------------------------------------------------- extension */

export default function alpacaTradingSafety(pi: ExtensionAPI) {
	const ok = (text: string, details: Record<string, unknown> = {}) => ({
		content: [{ type: "text" as const, text }],
		details,
	});
	const json = (value: unknown) => ok(JSON.stringify(value, null, 2), {});

	/* ---------------------------------------------------------- read tools */

	pi.registerTool({
		name: "alpaca_get_account",
		label: "Alpaca account",
		description:
			"Get the Alpaca account: equity, cash, buying power, day-trade count, blocks, and whether it is a paper or live account.",
		parameters: Type.Object({
			profile: Type.Optional(Type.String({ description: "Account profile: 'paper' (default) or 'live'" })),
		}),
		async execute(_id, params, signal) {
			const credentials = loadCredentials(params.profile);
			const account = (await api("GET", "/v2/account", {
				profile: credentials.profileName,
				signal,
			})) as Record<string, unknown>;
			return json({
				profile: credentials.profileName,
				environment: credentials.paper ? "paper" : "live",
				status: account.status,
				equity: account.equity,
				last_equity: account.last_equity,
				cash: account.cash,
				buying_power: account.buying_power,
				long_market_value: account.long_market_value,
				short_market_value: account.short_market_value,
				daytrade_count: account.daytrade_count,
				pattern_day_trader: account.pattern_day_trader,
				trading_blocked: account.trading_blocked,
				account_blocked: account.account_blocked,
				options_approved_level: account.options_approved_level,
				crypto_status: account.crypto_status,
			});
		},
	});

	pi.registerTool({
		name: "alpaca_list_positions",
		label: "Alpaca positions",
		description: "List all open Alpaca positions with market value and unrealized P/L.",
		parameters: Type.Object({
			profile: Type.Optional(Type.String({ description: "Account profile: 'paper' (default) or 'live'" })),
		}),
		async execute(_id, params, signal) {
			const positions = (await api("GET", "/v2/positions", {
				profile: params.profile,
				signal,
			})) as Record<string, unknown>[];
			return json(
				(positions ?? []).map((p) => ({
					symbol: p.symbol,
					asset_class: p.asset_class,
					side: p.side,
					qty: p.qty,
					avg_entry_price: p.avg_entry_price,
					current_price: p.current_price,
					market_value: p.market_value,
					cost_basis: p.cost_basis,
					unrealized_pl: p.unrealized_pl,
					unrealized_plpc: p.unrealized_plpc,
					change_today: p.change_today,
				})),
			);
		},
	});

	pi.registerTool({
		name: "alpaca_list_orders",
		label: "Alpaca orders",
		description: "List Alpaca orders, most recent first.",
		parameters: Type.Object({
			status: Type.Optional(
				Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")], {
					description: "Which orders to return (default: all)",
				}),
			),
			limit: Type.Optional(Type.Number({ description: "Max orders to return (default 25)" })),
			symbols: Type.Optional(Type.String({ description: "Comma-separated symbols to filter by" })),
			profile: Type.Optional(Type.String({ description: "Account profile: 'paper' (default) or 'live'" })),
		}),
		async execute(_id, params, signal) {
			const orders = (await api("GET", "/v2/orders", {
				params: {
					status: params.status ?? "all",
					limit: params.limit ?? 25,
					direction: "desc",
					symbols: params.symbols,
				},
				profile: params.profile,
				signal,
			})) as Record<string, unknown>[];
			return json(
				(orders ?? []).map((o) => ({
					id: o.id,
					client_order_id: o.client_order_id,
					symbol: o.symbol,
					side: o.side,
					type: o.order_type ?? o.type,
					qty: o.qty,
					notional: o.notional,
					filled_qty: o.filled_qty,
					filled_avg_price: o.filled_avg_price,
					limit_price: o.limit_price,
					stop_price: o.stop_price,
					time_in_force: o.time_in_force,
					status: o.status,
					created_at: o.created_at,
				})),
			);
		},
	});

	pi.registerTool({
		name: "alpaca_get_quote",
		label: "Alpaca quote",
		description:
			"Get the latest trade and quote for one or more symbols. Use 'BTC/USD' style for crypto.",
		parameters: Type.Object({
			symbols: Type.String({ description: "Comma-separated symbols, e.g. 'AAPL,MSFT' or 'BTC/USD'" }),
		}),
		async execute(_id, params, signal) {
			const list = params.symbols
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			const crypto = list.filter(isCrypto);
			const equities = list.filter((s) => !isCrypto(s));
			const out: Record<string, unknown> = {};
			if (equities.length) {
				const body = (await api("GET", "/v2/stocks/snapshots", {
					params: { symbols: equities.join(","), feed: "iex" },
					dataApi: true,
					signal,
				})) as Record<string, unknown>;
				const snapshots = (body?.snapshots ?? body) as Record<string, Record<string, unknown>>;
				for (const [symbol, snap] of Object.entries(snapshots ?? {})) {
					const trade = snap?.latestTrade as { p?: number } | undefined;
					const quote = snap?.latestQuote as { bp?: number; ap?: number } | undefined;
					const prev = snap?.prevDailyBar as { c?: number } | undefined;
					out[symbol] = {
						last: trade?.p,
						bid: quote?.bp,
						ask: quote?.ap,
						prev_close: prev?.c,
						change_pct:
							trade?.p && prev?.c ? Number((((trade.p - prev.c) / prev.c) * 100).toFixed(2)) : undefined,
					};
				}
			}
			if (crypto.length) {
				const body = (await api("GET", "/v1beta3/crypto/us/latest/trades", {
					params: { symbols: crypto.join(",") },
					dataApi: true,
					signal,
				})) as { trades?: Record<string, { p?: number }> };
				for (const [symbol, trade] of Object.entries(body?.trades ?? {})) {
					out[symbol] = { last: trade?.p };
				}
			}
			return json(out);
		},
	});

	pi.registerTool({
		name: "alpaca_get_option_contracts",
		label: "Alpaca option contracts",
		description: "Discover active option contracts for an underlying symbol.",
		parameters: Type.Object({
			underlying: Type.String({ description: "Underlying symbol, e.g. SPY" }),
			expiration_gte: Type.Optional(Type.String({ description: "Earliest expiration (YYYY-MM-DD)" })),
			expiration_lte: Type.Optional(Type.String({ description: "Latest expiration (YYYY-MM-DD)" })),
			type: Type.Optional(Type.Union([Type.Literal("call"), Type.Literal("put")])),
			strike_gte: Type.Optional(Type.Number({ description: "Minimum strike price" })),
			strike_lte: Type.Optional(Type.Number({ description: "Maximum strike price" })),
			limit: Type.Optional(Type.Number({ description: "Maximum contracts (default 50)" })),
			profile: Type.Optional(Type.String({ description: "Credential profile (default active profile)" })),
		}),
		async execute(_id, params, signal) {
			const body = (await api("GET", "/v2/options/contracts", {
				params: {
					underlying_symbols: params.underlying.toUpperCase(),
					expiration_date_gte: params.expiration_gte,
					expiration_date_lte: params.expiration_lte,
					type: params.type,
					strike_price_gte: params.strike_gte,
					strike_price_lte: params.strike_lte,
					limit: params.limit ?? 50,
					status: "active",
				},
				profile: params.profile,
				signal,
			})) as { option_contracts?: Record<string, unknown>[] };
			return json(
				(body?.option_contracts ?? []).map((contract) => ({
					symbol: contract.symbol,
					underlying_symbol: contract.underlying_symbol,
					expiration_date: contract.expiration_date,
					type: contract.type,
					strike_price: contract.strike_price,
					open_interest: contract.open_interest,
					close_price: contract.close_price,
				})),
			);
		},
	});

	pi.registerTool({
		name: "alpaca_get_option_quote",
		label: "Alpaca option quote",
		description: "Get indicative latest bid/ask quotes for OCC option symbols.",
		parameters: Type.Object({
			symbols: Type.String({ description: "Comma-separated OCC symbols" }),
			profile: Type.Optional(Type.String({ description: "Credential profile (default active profile)" })),
		}),
		async execute(_id, params, signal) {
			const symbols = params.symbols
				.split(",")
				.map((symbol) => symbol.trim().toUpperCase())
				.filter(Boolean);
			const body = (await api("GET", "/v1beta1/options/quotes/latest", {
				params: { symbols: symbols.join(","), feed: "indicative" },
				dataApi: true,
				profile: params.profile,
				signal,
			})) as { quotes?: Record<string, Record<string, unknown>> };
			const out: Record<string, unknown> = {};
			for (const symbol of symbols) {
				const quote = body?.quotes?.[symbol] ?? {};
				out[symbol] = {
					bid: quote.bp,
					ask: quote.ap,
					bid_size: quote.bs,
					ask_size: quote.as,
					last: quote.p ?? quote.last,
					timestamp: quote.t,
				};
			}
			return json(out);
		},
	});

	pi.registerTool({
		name: "alpaca_get_bars",
		label: "Alpaca bars",
		description: "Get historical OHLCV bars for a symbol.",
		parameters: Type.Object({
			symbol: Type.String({ description: "Symbol, e.g. 'AAPL' or 'BTC/USD'" }),
			timeframe: Type.Optional(
				Type.String({ description: "Bar size: 1Min, 5Min, 15Min, 1Hour, 1Day (default 1Day)" }),
			),
			limit: Type.Optional(Type.Number({ description: "Number of bars (default 30)" })),
			start: Type.Optional(Type.String({ description: "RFC3339 or YYYY-MM-DD start" })),
			end: Type.Optional(Type.String({ description: "RFC3339 or YYYY-MM-DD end" })),
			feed: Type.Optional(Type.String({ description: "Stock feed (default iex)" })),
		}),
		async execute(_id, params, signal) {
			const timeframe = params.timeframe ?? "1Day";
			const limit = params.limit ?? 30;
			const start = params.start ?? defaultBarsStart(timeframe, limit);
			if (isCrypto(params.symbol)) {
				const body = (await api("GET", "/v1beta3/crypto/us/bars", {
					params: {
						symbols: params.symbol,
						timeframe,
						limit,
						start,
						end: params.end,
						sort: "desc",
					},
					dataApi: true,
					signal,
				})) as { bars?: Record<string, unknown[]> };
				return json((body?.bars?.[params.symbol] ?? []).slice().reverse());
			}
			const body = (await api("GET", `/v2/stocks/${encodeURIComponent(params.symbol)}/bars`, {
				params: {
					timeframe,
					limit,
					start,
					end: params.end,
					feed: params.feed ?? "iex",
					sort: "desc",
				},
				dataApi: true,
				signal,
			})) as { bars?: unknown[] };
			return json((body?.bars ?? []).slice().reverse());
		},
	});

	pi.registerTool({
		name: "alpaca_get_clock",
		label: "Alpaca market clock",
		description: "Is the US market open right now, and when does it next open/close?",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			return json(await api("GET", "/v2/clock", { signal }));
		},
	});

	/* -------------------------------------------------------- write tools */

	const orderParams = {
		symbol: Type.String({ description: "Symbol, e.g. 'AAPL' or 'BTC/USD'" }),
		side: Type.Union([Type.Literal("buy"), Type.Literal("sell")]),
		qty: Type.Optional(Type.Number({ description: "Share/contract quantity (omit if using notional)" })),
		notional: Type.Optional(Type.Number({ description: "Dollar amount (market orders only)" })),
		type: Type.Optional(
			Type.Union(
				[Type.Literal("market"), Type.Literal("limit"), Type.Literal("stop"), Type.Literal("stop_limit")],
				{ description: "Order type (default market)" },
			),
		),
		limit_price: Type.Optional(Type.Number({ description: "Required for limit and stop_limit" })),
		stop_price: Type.Optional(Type.Number({ description: "Required for stop and stop_limit" })),
		time_in_force: Type.Optional(Type.String({ description: "day, gtc, ioc, fok (default day)" })),
		extended_hours: Type.Optional(Type.Boolean({ description: "Allow extended-hours fill" })),
		profile: Type.Optional(Type.String({ description: "Account profile: 'paper' (default) or 'live'" })),
	};

	const toIntent = (params: Record<string, unknown>): OrderIntent => ({
		symbol: String(params.symbol),
		side: params.side as "buy" | "sell",
		qty: params.qty as number | undefined,
		notional: params.notional as number | undefined,
		type: (params.type as OrderIntent["type"]) ?? "market",
		limit_price: params.limit_price as number | undefined,
		stop_price: params.stop_price as number | undefined,
		time_in_force:
			(params.time_in_force as string | undefined) ??
			(isCrypto(String(params.symbol)) ? "gtc" : "day"),
		extended_hours: params.extended_hours as boolean | undefined,
	});

	pi.registerTool({
		name: "alpaca_review_order",
		label: "Review Alpaca order",
		description:
			"REQUIRED before alpaca_place_order. Prices the order, checks it against the risk policy, and records the review. Reports what would happen without sending anything to the market.",
		parameters: Type.Object(orderParams),
		async execute(_id, params, signal) {
			const intent = toIntent(params as Record<string, unknown>);
			const requestedProfile = params.profile as string | undefined;
			const profile = resolveProfileName(requestedProfile);
			const policy = loadPolicy(profile);
			const decision = await evaluate(intent, signal, requestedProfile);

			// Record the review even when it fails: the record is keyed to this
			// exact order and scoped to this profile, so it cannot authorise another account.
			const ledger = loadLedger(profile);
			ledger.reviews.push({ ts: Date.now(), key: fingerprint(intent) });
			saveLedger(profile, ledger);

			audit({
				profile,
				event: "REVIEW",
				symbol: intent.symbol,
				side: intent.side,
				type: intent.type,
				notional: decision.notional,
				allowed: decision.allowed,
				reasons: decision.reasons,
			});

			// requireReview is satisfied by this very call, so exclude it from the preview.
			const blocking = decision.reasons.filter((r) => !r.startsWith("No alpaca_review_order"));
			return json({
				profile,
				order: intent,
				estimated_notional: decision.notional ?? null,
				notional_basis: decision.basis,
				would_be_allowed: blocking.length === 0,
				blocking_reasons: blocking,
				policy_snapshot: {
					profile,
					enabled: policy.enabled,
					paperOnly: policy.paperOnly,
					maxOrderNotional: policy.maxOrderNotional,
					marketOrderMaxNotional: policy.marketOrderMaxNotional,
					maxDailyNotional: policy.maxDailyNotional,
					remaining_today: policy.maxDailyNotional - ledger.dayNotional,
					orders_today: `${ledger.dayOrders}/${policy.maxOrdersPerDay}`,
				},
				next_step:
					blocking.length === 0
						? "Call alpaca_place_order with these exact parameters."
						: "Do NOT place this order. Adjust it, or report the blocking reasons. Never edit the policy to fit an order.",
			});
		},
	});

	pi.registerTool({
		name: "alpaca_place_order",
		label: "Place Alpaca order",
		description:
			"Place an order on Alpaca. Enforces the risk policy and requires a matching alpaca_review_order first. Refuses rather than asks.",
		parameters: Type.Object(orderParams),
		async execute(_id, params, signal) {
			const intent = toIntent(params as Record<string, unknown>);
			const requestedProfile = params.profile as string | undefined;
			const profile = resolveProfileName(requestedProfile);
			const decision = await evaluate(intent, signal, requestedProfile);

			if (!decision.allowed) {
				audit({
					profile,
					event: "PLACE_DENIED",
					symbol: intent.symbol,
					side: intent.side,
					type: intent.type,
					notional: decision.notional,
					reasons: decision.reasons,
				});
				return ok(
					`ORDER REFUSED by the Alpaca risk policy:\n- ${decision.reasons.join("\n- ")}\n\n` +
						"This is a policy decision, not a transient error. Do not retry unchanged, and do not edit " +
						"~/.pi/agent/alpaca-policy.json to make an order fit - raising a cap is a separate decision for the user.",
					{ refused: true, reasons: decision.reasons },
				);
			}

			const body: Record<string, unknown> = {
				symbol: intent.symbol,
				side: intent.side,
				type: intent.type,
				time_in_force: intent.time_in_force,
				// Tags orders as agent-placed so the dashboard can distinguish them.
				client_order_id: `pi-agent-${Date.now().toString(36)}-${fingerprint(intent).slice(0, 8)}`,
			};
			if (intent.qty !== undefined) body.qty = String(intent.qty);
			if (intent.notional !== undefined) body.notional = String(intent.notional);
			if (intent.limit_price !== undefined) body.limit_price = String(intent.limit_price);
			if (intent.stop_price !== undefined) body.stop_price = String(intent.stop_price);
			if (intent.extended_hours !== undefined) body.extended_hours = intent.extended_hours;

			let order: Record<string, unknown>;
			try {
				order = (await api("POST", "/v2/orders", {
					body,
					profile: requestedProfile,
					signal,
				})) as Record<string, unknown>;
			} catch (error) {
				audit({
					profile,
					event: "PLACE_ERROR",
					symbol: intent.symbol,
					side: intent.side,
					error: (error as Error).message,
				});
				throw error;
			}

			const ledger = loadLedger(profile);
			ledger.dayOrders += 1;
			ledger.dayNotional += decision.notional ?? 0;
			ledger.recent.push({ ts: Date.now(), hash: fingerprint(intent), notional: decision.notional ?? 0 });
			saveLedger(profile, ledger);

			audit({
				profile,
				event: "PLACE_ALLOWED",
				order_id: order.id,
				client_order_id: order.client_order_id,
				symbol: intent.symbol,
				side: intent.side,
				type: intent.type,
				notional: decision.notional,
				status: order.status,
			});

			return json({
				placed: true,
				profile,
				id: order.id,
				symbol: order.symbol,
				side: order.side,
				qty: order.qty,
				notional: order.notional,
				type: order.order_type ?? order.type,
				status: order.status,
				submitted_at: order.submitted_at,
				policy_usage: {
					orders_today: ledger.dayOrders,
					notional_today: ledger.dayNotional,
				},
			});
		},
	});

	pi.registerTool({
		name: "alpaca_cancel_order",
		label: "Cancel Alpaca order",
		description: "Cancel an open Alpaca order by id. Reducing exposure is always permitted.",
		parameters: Type.Object({
			order_id: Type.String({ description: "Alpaca order id" }),
			profile: Type.Optional(Type.String({ description: "Account profile: 'paper' (default) or 'live'" })),
		}),
		async execute(_id, params, signal) {
			const profile = resolveProfileName(params.profile);
			await api("DELETE", `/v2/orders/${encodeURIComponent(params.order_id)}`, {
				profile: params.profile,
				signal,
			});
			audit({ profile, event: "CANCEL", order_id: params.order_id });
			return ok(`Cancelled order ${params.order_id}.`, { order_id: params.order_id, profile });
		},
	});

	pi.registerTool({
		name: "alpaca_close_position",
		label: "Close Alpaca position",
		description:
			"Close an open position (fully, or a percentage). Reducing exposure is always permitted, so this is not notional-capped.",
		parameters: Type.Object({
			symbol: Type.String({ description: "Symbol of the position to close" }),
			percentage: Type.Optional(
				Type.Number({ description: "Percent of the position to close, 1-100 (default 100)" }),
			),
			profile: Type.Optional(Type.String({ description: "Account profile: 'paper' (default) or 'live'" })),
		}),
		async execute(_id, params, signal) {
			const profile = resolveProfileName(params.profile);
			const policy = loadPolicy(profile);
			if (!policy.enabled) {
				return ok(
					"Trading is halted (policy.enabled = false), so no order may be sent - including a closing one. " +
						"Re-enable in ~/.pi/agent/alpaca-policy.json if you intend to trade.",
					{ refused: true },
				);
			}
			const percentage = params.percentage ?? 100;
			const order = (await api("DELETE", `/v2/positions/${encodeURIComponent(params.symbol)}`, {
				params: percentage >= 100 ? {} : { percentage },
				profile: params.profile,
				signal,
			})) as Record<string, unknown>;
			audit({ profile, event: "CLOSE_POSITION", symbol: params.symbol, percentage, order_id: order?.id });
			return json({ closing: true, profile, symbol: params.symbol, percentage, order_id: order?.id ?? null });
		},
	});

	/* ---------------------------------------------------------- commands */

	pi.registerCommand("alpaca-safety", {
		description: "Show the autonomous Alpaca trading policy and today's usage",
		handler: async (_args, ctx) => {
			const profile = activeProfileName() ?? "paper";
			const policy = loadPolicy(profile);
			const ledger = loadLedger(profile);
			const lastHour = ledger.recent.filter((entry) => entry.ts >= Date.now() - 3600_000).length;
			let environment = "unknown (credentials unreadable)";
			try {
				const credentials = loadCredentials();
				environment = `${credentials.profileName} (${credentials.paper ? "paper" : "LIVE"})`;
			} catch {
				/* reported as unknown */
			}
			ctx.ui.notify(
				[
					`Alpaca autonomous trading: ${policy.enabled ? "ENABLED" : "HALTED"}`,
					`Account profile: ${environment}${policy.paperOnly ? " | policy: paper only" : " | policy: LIVE TRADING PERMITTED"}`,
					`Today: ${ledger.dayOrders}/${policy.maxOrdersPerDay} orders, ` +
						`${money(ledger.dayNotional)}/${money(policy.maxDailyNotional)} notional ` +
						`(${lastHour}/${policy.maxOrdersPerHour} this hour)`,
					`Per order: max ${money(policy.maxOrderNotional)}, market max ${money(policy.marketOrderMaxNotional)}`,
					`Options: ${policy.allowOptions ? "allowed" : "blocked"} | Shorting: ${policy.allowShorting ? "allowed" : "blocked"} | Crypto: ${policy.allowCrypto ? "allowed" : "blocked"}`,
					`Review required: ${policy.requireReview ? `yes (within ${policy.reviewMaxAgeSeconds}s)` : "no"}`,
					`Policy file: ${POLICY_PATH}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("alpaca-halt", {
		description: "Immediately halt autonomous Alpaca trading (sets enabled=false)",
		handler: async (_args, ctx) => {
			const policy = loadPolicy();
			policy.enabled = false;
			try {
				mkdirSync(dirname(POLICY_PATH), { recursive: true });
				writeFileSync(POLICY_PATH, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
				audit({ event: "HALT", source: "/alpaca-halt" });
				ctx.ui.notify("Alpaca trading HALTED. No orders will be placed until enabled is set true.", "warning");
			} catch (error) {
				ctx.ui.notify(`Could not write policy: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("alpaca-setup", {
		description: "Store Alpaca API keys in ~/.pi/agent/alpaca-credentials.json (editor only, never chat)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/alpaca-setup requires an interactive Pi session.", "error");
				return;
			}
			let current = "";
			try {
				current = readFileSync(CREDENTIALS_PATH, "utf8");
			} catch {
				current = `${JSON.stringify(
					{
						profiles: {
							paper: {
								baseUrl: "https://paper-api.alpaca.markets",
								keyId: "PK...",
								secretKey: "...",
								paper: true,
							},
						},
						activeProfile: "paper",
					},
					null,
					2,
				)}\n`;
			}
			const input = await ctx.ui.editor(
				"Alpaca credentials. Edit and submit HERE - never paste API keys into chat. Written with mode 600 and never committed to git.",
				current,
			);
			if (!input?.trim()) {
				ctx.ui.notify("Alpaca setup canceled; credentials unchanged.", "warning");
				return;
			}
			try {
				const parsed = JSON.parse(input);
				const name = parsed.activeProfile ?? "paper";
				const profile = parsed.profiles?.[name];
				if (!profile?.keyId || !profile?.secretKey || !profile?.baseUrl) {
					ctx.ui.notify(`Profile "${name}" needs baseUrl, keyId and secretKey.`, "error");
					return;
				}
				mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true });
				const tmp = `${CREDENTIALS_PATH}.tmp`;
				writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
				renameSync(tmp, CREDENTIALS_PATH);
				ctx.ui.notify(
					`Alpaca credentials saved (profile "${name}", ${profile.paper === false ? "LIVE" : "paper"}). Verify with alpaca_get_account.`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Not valid JSON: ${(error as Error).message}`, "error");
			}
		},
	});
}
