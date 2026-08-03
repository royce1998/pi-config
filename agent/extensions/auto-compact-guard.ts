/**
 * auto-compact-guard
 *
 * A safety net around pi's built-in auto-compaction. It does NOT compact on its own.
 *
 * ---------------------------------------------------------------------------
 * Why the actual compaction is left to pi
 * ---------------------------------------------------------------------------
 * Pi's built-in auto-compaction runs *inside* the agent loop (after each assistant
 * message) and is therefore race-free: it compacts and the turn continues.
 *
 * An extension cannot do that safely. `ctx.compact()` is fire-and-forget and calls
 * `abort()` internally, so triggering it from an extension either
 *   - kills the in-flight turn ("Request aborted") when fired during a turn, or
 *   - races the next queued prompt when fired at `agent_settled`, rebuilding the
 *     session underneath a running turn and orphaning a tool_result, which the
 *     provider rejects with HTTP 400 ("unexpected tool_use_id in tool_result blocks").
 * Both were observed in testing, so automatic extension-driven compaction is out.
 *
 * The trigger point is configured instead in ~/.pi/agent/settings.json:
 *
 *     contextTokens > contextWindow - compaction.reserveTokens
 *
 * With reserveTokens = 100000 on a 1,000,000-token model that is exactly 90%.
 *
 * ---------------------------------------------------------------------------
 * What this extension is for
 * ---------------------------------------------------------------------------
 * The original crash happened because compaction was failing SILENTLY (every
 * summarization request 421'd against the wrong Copilot endpoint), so context just
 * kept growing until the session died. Nothing warned about it.
 *
 * This watchdog closes that hole:
 *   - warns once when usage crosses the warn threshold (default 90%),
 *   - escalates loudly if usage is still climbing past the danger threshold
 *     (default 95%), which means the built-in net is not working,
 *   - `/auto-compact` reports exact usage and can compact on demand (safe, because
 *     it is user-initiated while idle).
 *
 * Config (optional env vars):
 *   PI_AUTO_COMPACT_WARN     default 90   warn at/above this % of the window
 *   PI_AUTO_COMPACT_DANGER   default 95   escalate at/above this %
 *   PI_AUTO_COMPACT_QUIET    set to "1"   suppress notifications
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_WARN_PERCENT = 90;
const DEFAULT_DANGER_PERCENT = 95;

function readPercent(envVar: string, fallback: number): number {
	const raw = Number(process.env[envVar]);
	if (!Number.isFinite(raw) || raw <= 0 || raw >= 100) return fallback;
	return raw;
}

export default function (pi: ExtensionAPI) {
	let warnPercent = readPercent("PI_AUTO_COMPACT_WARN", DEFAULT_WARN_PERCENT);
	let dangerPercent = readPercent("PI_AUTO_COMPACT_DANGER", DEFAULT_DANGER_PERCENT);
	const quiet = process.env.PI_AUTO_COMPACT_QUIET === "1";

	/** Highest usage band already reported, so we warn on transitions only. */
	let reported: "none" | "warn" | "danger" = "none";

	const notify = (ctx: ExtensionContext, msg: string, level: "info" | "warn" | "error") => {
		if (quiet) return;
		try {
			// `ctx` goes stale after compaction replaces the session, and even reading
			// `ctx.hasUI` throws in that state, so guard the check and the call together.
			if (!ctx.hasUI) return;
			ctx.ui.notify(msg, level);
		} catch {
			// Best-effort only; never let a stale ctx break the session.
		}
	};

	const usageOf = (ctx: ExtensionContext) => {
		try {
			const u = ctx.getContextUsage();
			// `tokens` is null right after a compaction, before the next LLM response.
			if (!u || u.tokens === null || !u.contextWindow) return undefined;
			return { tokens: u.tokens, window: u.contextWindow, percent: (u.tokens / u.contextWindow) * 100 };
		} catch {
			return undefined;
		}
	};

	pi.on("agent_settled", (_event, ctx) => {
		const usage = usageOf(ctx);
		if (!usage) return;

		if (usage.percent >= dangerPercent) {
			if (reported !== "danger") {
				reported = "danger";
				notify(
					ctx,
					`Context ${usage.percent.toFixed(1)}% full and auto-compaction has not reclaimed it. ` +
						`Run /compact now - a crash is likely.`,
					"error",
				);
			}
			return;
		}

		if (usage.percent >= warnPercent) {
			if (reported === "none") {
				reported = "warn";
				notify(ctx, `Context ${usage.percent.toFixed(1)}% full - auto-compaction should trigger shortly.`, "warn");
			}
			return;
		}

		// Dropped back below the warn line (usually because compaction ran).
		reported = "none";
	});

	// Compaction succeeded, so the next crossing should warn again.
	pi.on("session_compact", () => {
		reported = "none";
	});

	pi.on("session_start", () => {
		reported = "none";
		warnPercent = readPercent("PI_AUTO_COMPACT_WARN", DEFAULT_WARN_PERCENT);
		dangerPercent = readPercent("PI_AUTO_COMPACT_DANGER", DEFAULT_DANGER_PERCENT);
	});

	pi.registerCommand("auto-compact", {
		description: "Show context usage, or 'now' to compact immediately",
		handler: async (args, ctx) => {
			const usage = usageOf(ctx);

			if (args.trim().toLowerCase() === "now") {
				// Safe here: user-initiated, and command handlers run while idle.
				notify(ctx, "Compacting...", "info");
				ctx.compact({
					onComplete: () => notify(ctx, "Context compacted", "info"),
					onError: (e) => notify(ctx, `Compaction failed: ${e.message}`, "error"),
				});
				return;
			}

			if (!usage) {
				notify(ctx, "Context usage unknown (no assistant response yet, or just compacted)", "info");
				return;
			}
			notify(
				ctx,
				`Context ${usage.percent.toFixed(1)}% - ${usage.tokens.toLocaleString()} / ${usage.window.toLocaleString()} tokens ` +
					`| warn ${warnPercent}% | danger ${dangerPercent}%`,
				"info",
			);
		},
	});
}
