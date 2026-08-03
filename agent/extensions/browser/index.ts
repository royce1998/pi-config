/**
 * pi-browser — site-agnostic browser control for pi.
 *
 * Drives your installed Chrome with a persistent profile so logins stick.
 * Tools work on ANY page via an accessibility snapshot: interactive elements
 * get stable refs ([e1], [e2], ...) that you click/fill by ref. Works across
 * iframes (Greenhouse / Workday embeds).
 *
 * Designed for a job-search helper, but the tools are general purpose.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chromium, type BrowserContext, type Page, type Locator } from "playwright-core";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { assertPublicHttpUrl, installPublicNetworkGuard } from "./public-safety.mjs";

const DATA_DIR = join(homedir(), ".pi", "agent", "job-search");
const PUBLIC_MODE = process.env.PI_BROWSER_PUBLIC_MODE === "1";
const HEADLESS = process.env.PI_BROWSER_HEADLESS === "1";

function findChromiumExecutable(): string | undefined {
  const configured = process.env.PI_BROWSER_EXECUTABLE_PATH?.trim();
  if (configured && existsSync(configured)) return configured;
  const cache = join(homedir(), ".cache", "ms-playwright");
  try {
    const versions = readdirSync(cache, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^chromium-\d+$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const version of versions) {
      const executable = join(cache, version, "chrome-linux", "chrome");
      if (existsSync(executable)) return executable;
    }
  } catch {
    // Fall back to Playwright's installed Chrome channel lookup.
  }
  return undefined;
}

const CHROMIUM_EXECUTABLE = findChromiumExecutable();
// Per-worker isolation: each parallel pi worker sets PI_BROWSER_PROFILE_DIR to its
// own Chrome profile so multiple workers can each drive their own window. Falls back
// to the shared default when unset (single-session behavior, unchanged).
const PROFILE_DIR = process.env.PI_BROWSER_PROFILE_DIR && process.env.PI_BROWSER_PROFILE_DIR.trim()
  ? process.env.PI_BROWSER_PROFILE_DIR
  : join(DATA_DIR, "browser-profile");
// When an explicit per-worker profile is set, we OWN that dir exclusively, so it
// is safe to clear a stale Chrome singleton lock left behind by a crashed worker
// (this is what lets N parallel workers each reuse their own profile reliably).
// The shared default profile is never auto-cleared (it might be a live Chrome).
const ISOLATED_PROFILE = !!(process.env.PI_BROWSER_PROFILE_DIR && process.env.PI_BROWSER_PROFILE_DIR.trim());

function clearStaleChromeLocks(dir: string): void {
  // POSIX: SingletonLock/Cookie/Socket symlinks; Windows: lockfile.
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"]) {
    try {
      rmSync(join(dir, name), { force: true, recursive: false });
    } catch {
      /* ignore */
    }
  }
}
const NAV_TIMEOUT = 45_000;
const ACTION_TIMEOUT = 15_000;
const MAX_ELEMENTS = 200;

// ---- module-scoped browser state (one shared browser per pi process) ----
let context: BrowserContext | null = null;
let activePage: Page | null = null;
let launching: Promise<void> | null = null; // guard against concurrent launches

async function launchContext(): Promise<void> {
  mkdirSync(PROFILE_DIR, { recursive: true });
  if (ISOLATED_PROFILE) clearStaleChromeLocks(PROFILE_DIR);
  let ctx: BrowserContext;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      ...(CHROMIUM_EXECUTABLE ? { executablePath: CHROMIUM_EXECUTABLE } : { channel: "chrome" }),
      headless: HEADLESS,
      viewport: HEADLESS ? { width: 1440, height: 900 } : null,
      serviceWorkers: PUBLIC_MODE ? "block" : "allow",
      args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
    });
    if (PUBLIC_MODE) await installPublicNetworkGuard(ctx);
  } catch (e) {
    throw new Error(
      `Could not launch Chrome for profile "${PROFILE_DIR}". ` +
        `Chrome allows only one process per profile dir, so parallel workers must each set ` +
        `PI_BROWSER_PROFILE_DIR to a UNIQUE directory. If another pi/Chrome is using this profile, ` +
        `close it (or pick a different dir). Original error: ${(e as Error).message}`,
    );
  }
  ctx.setDefaultNavigationTimeout(NAV_TIMEOUT);
  ctx.setDefaultTimeout(ACTION_TIMEOUT);
  ctx.on("page", (p) => {
    activePage = p;
  });
  ctx.on("close", () => {
    context = null;
    activePage = null;
  });
  context = ctx;
  const pages = ctx.pages();
  activePage = pages.length ? pages[0] : await ctx.newPage();
}

async function ensureBrowser(): Promise<Page> {
  // Serialize launches so parallel tool calls can never spawn a second Chrome
  // against the same profile (which corrupts the session).
  if (!context) {
    if (!launching) {
      launching = launchContext().finally(() => {
        launching = null;
      });
    }
    await launching;
  }
  if (!activePage || activePage.isClosed()) {
    const pages = context!.pages().filter((p) => !p.isClosed());
    activePage = pages.length ? pages[pages.length - 1] : await context!.newPage();
  }
  return activePage!;
}

async function closeBrowser(): Promise<void> {
  try {
    await context?.close();
  } catch {
    /* ignore */
  }
  context = null;
  activePage = null;
}

// Injected into every frame. Tags visible interactive elements with data-pi-ref
// and returns a compact description list. Runs in the browser, not Node.
function snapshotFrame(startIndex: number) {
  const out: Array<Record<string, unknown>> = [];
  let i = startIndex;

  const isVisible = (el: Element): boolean => {
    const he = el as HTMLElement;
    const rect = he.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const s = getComputedStyle(he);
    if (s.visibility === "hidden" || s.display === "none") return false;
    if (parseFloat(s.opacity || "1") === 0) return false;
    return true;
  };

  const clean = (s: string | null | undefined): string =>
    (s || "").replace(/\s+/g, " ").trim().slice(0, 120);

  const accName = (el: Element): string => {
    const he = el as HTMLElement & {
      value?: string;
      placeholder?: string;
      name?: string;
      title?: string;
    };
    const aria = he.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledby = he.getAttribute("aria-labelledby");
    if (labelledby) {
      const txt = labelledby
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ");
      if (clean(txt)) return clean(txt);
    }
    if (he.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(he.id)}"]`);
      if (lbl && clean(lbl.textContent)) return clean(lbl.textContent);
    }
    const wrap = he.closest("label");
    if (wrap && clean(wrap.textContent)) return clean(wrap.textContent);
    if (he.placeholder) return clean(he.placeholder);
    const txt = clean(he.innerText || he.textContent);
    if (txt) return txt;
    if (he.name) return clean(he.name);
    if (he.title) return clean(he.title);
    return "";
  };

  document
    .querySelectorAll("[data-pi-ref]")
    .forEach((e) => e.removeAttribute("data-pi-ref"));

  const sel = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="combobox"]',
    '[contenteditable="true"]',
    "summary",
  ].join(",");

  const seen = new Set<Element>();
  document.querySelectorAll(sel).forEach((el) => {
    if (seen.has(el) || !isVisible(el)) return;
    seen.add(el);
    if (i - startIndex >= 250) return; // per-frame cap
    const he = el as HTMLElement & {
      value?: string;
      type?: string;
      checked?: boolean;
      required?: boolean;
      disabled?: boolean;
      href?: string;
    };
    i += 1;
    const ref = `e${i}`;
    he.setAttribute("data-pi-ref", ref);
    const tag = he.tagName.toLowerCase();
    const type = he.getAttribute("type") || "";
    const isField = tag === "input" || tag === "textarea" || tag === "select";
    out.push({
      ref,
      tag,
      type,
      role: he.getAttribute("role") || "",
      name: accName(he),
      value: isField ? clean(he.value) : "",
      checked:
        type === "checkbox" || type === "radio" ? Boolean(he.checked) : undefined,
      required:
        he.required || he.getAttribute("aria-required") === "true" || undefined,
      disabled: he.disabled || undefined,
      href: tag === "a" ? clean(he.getAttribute("href")) : "",
    });
  });

  return { elements: out, next: i };
}

type SnapEl = {
  ref: string;
  tag: string;
  type: string;
  role: string;
  name: string;
  value: string;
  checked?: boolean;
  required?: boolean;
  disabled?: boolean;
  href: string;
};

async function takeSnapshot(page: Page): Promise<{ text: string; count: number }> {
  await page
    .waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT })
    .catch(() => {});
  let index = 0;
  const lines: string[] = [];
  const frames = page.frames();
  for (const frame of frames) {
    let res: { elements: SnapEl[]; next: number };
    try {
      res = (await frame.evaluate(snapshotFrame, index)) as {
        elements: SnapEl[];
        next: number;
      };
    } catch {
      continue; // cross-origin frame we can't script; skip
    }
    index = res.next;
    if (res.elements.length === 0) continue;
    if (frames.length > 1 && frame !== page.mainFrame()) {
      lines.push(`  (iframe: ${frame.url().slice(0, 80)})`);
    }
    for (const el of res.elements) {
      if (lines.length >= MAX_ELEMENTS) break;
      const parts: string[] = [`[${el.ref}]`];
      parts.push(`<${el.tag}${el.type ? ` type=${el.type}` : ""}>`);
      if (el.name) parts.push(JSON.stringify(el.name));
      if (el.value) parts.push(`= ${JSON.stringify(el.value)}`);
      if (el.checked !== undefined) parts.push(el.checked ? "[x]" : "[ ]");
      if (el.required) parts.push("*required");
      if (el.disabled) parts.push("(disabled)");
      if (el.href && el.href !== "#") parts.push(`-> ${el.href}`);
      lines.push(parts.join(" "));
    }
    if (lines.length >= MAX_ELEMENTS) break;
  }
  const truncated = lines.length >= MAX_ELEMENTS;
  const header = `URL: ${page.url()}\nTITLE: ${await page.title().catch(() => "")}\n`;
  const body =
    lines.length > 0 ? lines.join("\n") : "(no interactive elements found)";
  const footer = truncated
    ? `\n... (list truncated at ${MAX_ELEMENTS}; scroll or narrow the page)`
    : "";
  return { text: `${header}\nInteractive elements:\n${body}${footer}`, count: lines.length };
}

// Resolve a ref across all frames (refs assigned by the last snapshot).
async function resolveRef(page: Page, ref: string): Promise<Locator | null> {
  const escaped = ref.replace(/"/g, '\\"');
  for (const frame of page.frames()) {
    const loc = frame.locator(`[data-pi-ref="${escaped}"]`);
    try {
      if ((await loc.count()) > 0) return loc.first();
    } catch {
      /* frame gone */
    }
  }
  return null;
}

function txt(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function staleRefMsg(ref: string) {
  return txt(
    `Could not find element ${ref}. The page likely changed. Call browser_snapshot again to get fresh refs, then retry.`,
    { error: "stale_ref", ref },
  );
}

async function confirmPublicAction(
  page: Page,
  locator: Locator | null,
  ctx: { ui: { confirm: (title: string, message: string, options?: { timeout?: number }) => Promise<boolean> } },
  action: string,
  always = false,
): Promise<void> {
  if (!PUBLIC_MODE) return;
  let description = action;
  let sensitive = always;
  if (locator) {
    const details = await locator
      .evaluate((element) => {
        const input = element as HTMLInputElement;
        const text =
          element.getAttribute("aria-label") ||
          input.value ||
          (element as HTMLElement).innerText ||
          element.textContent ||
          element.getAttribute("title") ||
          "unlabeled control";
        return { text: text.replace(/\s+/g, " ").trim().slice(0, 240), type: input.type || "" };
      })
      .catch(() => ({ text: "unlabeled control", type: "" }));
    description = `${action}: ${details.text}`;
    sensitive =
      sensitive ||
      details.type.toLowerCase() === "submit" ||
      /\b(?:submit|send|apply|finish|complete|withdraw|delete|remove|purchase|buy|place order|accept offer|confirm application)\b/iu.test(
        details.text,
      );
  }
  if (!sensitive) return;
  const approved = await ctx.ui.confirm(
    "Approve consequential browser action?",
    `${description}\n\nPage: ${page.url().slice(0, 500)}\n\nApprove this one action only?`,
    { timeout: 5 * 60 * 1000 },
  );
  if (!approved) throw new Error("Consequential browser action was denied by the public web user");
}

export default function browserExtension(pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => {
    await closeBrowser();
  });

  // 1. open / ensure browser, optionally navigate
  pi.registerTool({
    name: "browser_open",
    label: "Open Browser",
    description:
      "Launch (or focus) the automated Chrome window and optionally navigate to a URL. " +
      "The window is visible so you can watch, log in to sites, solve CAPTCHAs, and click final Submit yourself. " +
      "Logins persist across sessions in a dedicated profile. Returns a snapshot of the page.",
    parameters: Type.Object({
      url: Type.Optional(
        Type.String({ description: "Optional URL to open, e.g. https://…" }),
      ),
    }),
    async execute(_id, params) {
      const page = await ensureBrowser();
      if (params.url) {
        if (PUBLIC_MODE) await assertPublicHttpUrl(params.url);
        await page.goto(params.url, { waitUntil: "domcontentloaded" }).catch(() => {});
      }
      const snap = await takeSnapshot(page);
      return txt(snap.text, { count: snap.count });
    },
  });

  // 2. navigate
  pi.registerTool({
    name: "browser_navigate",
    label: "Navigate",
    description: "Navigate the active tab to a URL and return a fresh page snapshot.",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute URL (include https://)" }),
    }),
    async execute(_id, params) {
      const page = await ensureBrowser();
      if (PUBLIC_MODE) await assertPublicHttpUrl(params.url);
      await page.goto(params.url, { waitUntil: "domcontentloaded" }).catch(() => {});
      const snap = await takeSnapshot(page);
      return txt(snap.text, { count: snap.count });
    },
  });

  // 3. snapshot (the "see the page" tool)
  pi.registerTool({
    name: "browser_snapshot",
    label: "Snapshot",
    description:
      "Return the current page's URL, title, and a numbered list of interactive elements " +
      "([e1], [e2], …) with their type, label, and value. ALWAYS call this before clicking or " +
      "filling, and again after the page changes, because refs go stale on navigation.",
    parameters: Type.Object({}),
    async execute() {
      const page = await ensureBrowser();
      const snap = await takeSnapshot(page);
      return txt(snap.text, { count: snap.count });
    },
  });

  // 4. read visible text (for job descriptions etc.)
  pi.registerTool({
    name: "browser_read",
    label: "Read Text",
    description:
      "Return the visible text content of the page (main readable text, e.g. a job description). " +
      "Use browser_snapshot instead when you need to interact with elements.",
    parameters: Type.Object({
      maxChars: Type.Optional(
        Type.Number({ description: "Max characters to return (default 8000)" }),
      ),
    }),
    async execute(_id, params) {
      const page = await ensureBrowser();
      const max = params.maxChars ?? 8000;
      const text = await page
        .evaluate(() => document.body?.innerText || "")
        .catch(() => "");
      const clipped = text.replace(/\n{3,}/g, "\n\n").slice(0, max);
      const more = text.length > max ? `\n... (${text.length - max} more chars)` : "";
      return txt(`URL: ${page.url()}\n\n${clipped}${more}`);
    },
  });

  // 5. click
  pi.registerTool({
    name: "browser_click",
    label: "Click",
    description: "Click the element with the given ref (from the latest snapshot).",
    parameters: Type.Object({
      ref: Type.String({ description: 'Element ref, e.g. "e12"' }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const page = await ensureBrowser();
      const loc = await resolveRef(page, params.ref);
      if (!loc) return staleRefMsg(params.ref);
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await confirmPublicAction(page, loc, ctx, "Click");
      await loc.click({ timeout: ACTION_TIMEOUT });
      await page.waitForTimeout(500);
      const snap = await takeSnapshot(page);
      return txt(`Clicked ${params.ref}.\n\n${snap.text}`, { count: snap.count });
    },
  });

  // 6. fill
  pi.registerTool({
    name: "browser_fill",
    label: "Fill Field",
    description:
      "Type a value into an input / textarea / contenteditable by ref. Clears existing content first. " +
      "Set submit=true to press Enter afterward (useful for search boxes).",
    parameters: Type.Object({
      ref: Type.String({ description: 'Element ref, e.g. "e5"' }),
      value: Type.String({ description: "Text to enter" }),
      submit: Type.Optional(
        Type.Boolean({ description: "Press Enter after filling (default false)" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const page = await ensureBrowser();
      const loc = await resolveRef(page, params.ref);
      if (!loc) return staleRefMsg(params.ref);
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.fill(params.value, { timeout: ACTION_TIMEOUT });
      if (params.submit) {
        await confirmPublicAction(page, loc, ctx, "Press Enter after filling", true);
        await loc.press("Enter");
        await page.waitForTimeout(600);
      }
      const snap = await takeSnapshot(page);
      return txt(`Filled ${params.ref}.\n\n${snap.text}`, { count: snap.count });
    },
  });

  // 7. select dropdown option
  pi.registerTool({
    name: "browser_select",
    label: "Select Option",
    description:
      "Choose an option in a native <select> by visible label or value. For custom dropdowns " +
      "(divs), click to open then browser_snapshot + browser_click the option instead.",
    parameters: Type.Object({
      ref: Type.String({ description: "Ref of the <select> element" }),
      option: Type.String({ description: "Option label or value to select" }),
    }),
    async execute(_id, params) {
      const page = await ensureBrowser();
      const loc = await resolveRef(page, params.ref);
      if (!loc) return staleRefMsg(params.ref);
      try {
        await loc.selectOption({ label: params.option }, { timeout: ACTION_TIMEOUT });
      } catch {
        await loc.selectOption(params.option, { timeout: ACTION_TIMEOUT });
      }
      const snap = await takeSnapshot(page);
      return txt(`Selected "${params.option}" in ${params.ref}.\n\n${snap.text}`, {
        count: snap.count,
      });
    },
  });

  // 7b. custom dropdown / combobox / autocomplete — ONE-SHOT select
  pi.registerTool({
    name: "browser_choose",
    label: "Choose (custom dropdown)",
    description:
      "One-shot selector for CUSTOM dropdowns / comboboxes / autocompletes (Greenhouse, Ashby, " +
      "react-select, Google-Places location fields). Give the field's ref and the visible option " +
      "text; it opens the control, filters with real keystrokes, and clicks the matching option in a " +
      "single step. Use this for ANY non-native dropdown instead of manual click+fill+press. For a " +
      "native <select>, use browser_select instead.",
    parameters: Type.Object({
      ref: Type.String({ description: "Ref of the dropdown/combobox/autocomplete field" }),
      option: Type.String({ description: "Visible option text to select (exact label preferred)" }),
    }),
    async execute(_id, params) {
      const page = await ensureBrowser();
      const loc = await resolveRef(page, params.ref);
      if (!loc) return staleRefMsg(params.ref);
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click().catch(() => {});
      await page.waitForTimeout(250);
      // Real keystrokes so react-select filtering AND Google Places both fire.
      let typed = false;
      try {
        await loc.fill("");
        await loc.pressSequentially(params.option, { delay: 8 });
        typed = true;
      } catch {
        /* pure button dropdown (not a text input) — options already open */
      }
      await page.waitForTimeout(400);
      let method = "";
      // 1) Click a real listbox option (react-select / Greenhouse / Ashby).
      for (const frame of page.frames()) {
        try {
          let opt = frame.getByRole("option", { name: params.option, exact: true }).first();
          if ((await opt.count()) === 0)
            opt = frame.getByRole("option", { name: params.option, exact: false }).first();
          if ((await opt.count()) > 0) {
            await opt.click({ timeout: 5000 });
            method = "option-click";
            break;
          }
        } catch {
          /* try next frame */
        }
      }
      // 2) Google Places suggestion fallback.
      if (!method) {
        try {
          const pac = page.locator(".pac-item").first();
          if ((await pac.count()) > 0) {
            await pac.click({ timeout: 3000 });
            method = "places-click";
          }
        } catch {
          /* ignore */
        }
      }
      // 3) Keyboard fallback: highlight first match, select.
      if (!method && typed && !PUBLIC_MODE) {
        await loc.press("ArrowDown").catch(() => {});
        await loc.press("Enter").catch(() => {});
        method = "keyboard";
      }
      await page.waitForTimeout(300);
      const snap = await takeSnapshot(page);
      return txt(
        `Chose \"${params.option}\" for ${params.ref}` +
          (method ? ` (${method}).` : " (no match found \u2014 re-snapshot and verify).") +
          `\n\n${snap.text}`,
        { count: snap.count, method },
      );
    },
  });

  // 8. checkbox / radio
  pi.registerTool({
    name: "browser_set_checkbox",
    label: "Set Checkbox",
    description: "Check or uncheck a checkbox / radio by ref.",
    parameters: Type.Object({
      ref: Type.String({ description: "Ref of the checkbox or radio" }),
      checked: Type.Boolean({ description: "true to check, false to uncheck" }),
    }),
    async execute(_id, params) {
      const page = await ensureBrowser();
      const loc = await resolveRef(page, params.ref);
      if (!loc) return staleRefMsg(params.ref);
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.setChecked(params.checked, { timeout: ACTION_TIMEOUT }).catch(async () => {
        await loc.click();
      });
      return txt(`Set ${params.ref} checked=${params.checked}.`);
    },
  });

  // 9. file upload (resume)
  pi.registerTool({
    name: "browser_upload",
    label: "Upload File",
    description:
      "Attach a local file to a file input (e.g. upload a resume/CV). Provide the input's ref and an absolute file path.",
    parameters: Type.Object({
      ref: Type.String({ description: "Ref of the file <input>" }),
      path: Type.String({ description: "Absolute path to the local file" }),
    }),
    async execute(_id, params) {
      const page = await ensureBrowser();
      const loc = await resolveRef(page, params.ref);
      if (!loc) return staleRefMsg(params.ref);
      await loc.setInputFiles(params.path, { timeout: ACTION_TIMEOUT });
      await page.waitForTimeout(800);
      const snap = await takeSnapshot(page);
      return txt(`Uploaded ${params.path} to ${params.ref}.\n\n${snap.text}`, {
        count: snap.count,
      });
    },
  });

  // 10. keyboard
  pi.registerTool({
    name: "browser_press",
    label: "Press Key",
    description:
      'Press a keyboard key (e.g. "Enter", "Escape", "Tab", "ArrowDown"). Optionally target a ref first.',
    parameters: Type.Object({
      key: Type.String({ description: 'Key name, e.g. "Enter"' }),
      ref: Type.Optional(Type.String({ description: "Optional element ref to focus first" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const page = await ensureBrowser();
      if (params.ref) {
        const loc = await resolveRef(page, params.ref);
        if (!loc) return staleRefMsg(params.ref);
        if (params.key.toLowerCase() === "enter") await confirmPublicAction(page, loc, ctx, "Press Enter", true);
        await loc.press(params.key);
      } else {
        if (params.key.toLowerCase() === "enter") await confirmPublicAction(page, null, ctx, "Press Enter", true);
        await page.keyboard.press(params.key);
      }
      await page.waitForTimeout(400);
      const snap = await takeSnapshot(page);
      return txt(`Pressed ${params.key}.\n\n${snap.text}`, { count: snap.count });
    },
  });

  // 11. scroll
  pi.registerTool({
    name: "browser_scroll",
    label: "Scroll",
    description:
      'Scroll the page "down"/"up" by ~one viewport, or scroll a specific ref into view.',
    parameters: Type.Object({
      direction: Type.Optional(
        Type.Union([Type.Literal("down"), Type.Literal("up")], {
          description: "Scroll direction (default down)",
        }),
      ),
      ref: Type.Optional(Type.String({ description: "Scroll this ref into view instead" })),
    }),
    async execute(_id, params) {
      const page = await ensureBrowser();
      if (params.ref) {
        const loc = await resolveRef(page, params.ref);
        if (!loc) return staleRefMsg(params.ref);
        await loc.scrollIntoViewIfNeeded();
      } else {
        const dir = params.direction === "up" ? -1 : 1;
        await page.evaluate((d) => window.scrollBy(0, d * window.innerHeight * 0.9), dir);
      }
      await page.waitForTimeout(400);
      const snap = await takeSnapshot(page);
      return txt(snap.text, { count: snap.count });
    },
  });

  // 12. screenshot (returns an image the model can see)
  pi.registerTool({
    name: "browser_screenshot",
    label: "Screenshot",
    description:
      "Capture a PNG screenshot of the current page so you can visually inspect layout, " +
      "custom widgets, or CAPTCHAs. Use when the snapshot text is ambiguous.",
    parameters: Type.Object({
      fullPage: Type.Optional(
        Type.Boolean({ description: "Capture the full scrollable page (default false)" }),
      ),
    }),
    async execute(_id, params) {
      const page = await ensureBrowser();
      const buf = await page.screenshot({
        type: "png",
        fullPage: params.fullPage ?? false,
      });
      return {
        content: [
          { type: "text" as const, text: `Screenshot of ${page.url()}` },
          { type: "image" as const, data: buf.toString("base64"), mimeType: "image/png" },
        ],
        details: {},
      };
    },
  });

  // 13. wait
  pi.registerTool({
    name: "browser_wait",
    label: "Wait",
    description:
      "Wait for the page to settle: for milliseconds, and/or until some text appears. " +
      "Use after actions that trigger async loading.",
    parameters: Type.Object({
      ms: Type.Optional(Type.Number({ description: "Milliseconds to wait" })),
      text: Type.Optional(Type.String({ description: "Wait until this text is visible" })),
    }),
    async execute(_id, params) {
      const page = await ensureBrowser();
      if (params.text) {
        await page
          .getByText(params.text, { exact: false })
          .first()
          .waitFor({ timeout: NAV_TIMEOUT })
          .catch(() => {});
      }
      if (params.ms) await page.waitForTimeout(params.ms);
      if (!params.text && !params.ms) await page.waitForTimeout(1000);
      const snap = await takeSnapshot(page);
      return txt(snap.text, { count: snap.count });
    },
  });

  // 14. list tabs
  pi.registerTool({
    name: "browser_tabs",
    label: "List Tabs",
    description: "List all open tabs with their index, title, and URL.",
    parameters: Type.Object({}),
    async execute() {
      await ensureBrowser();
      if (!context) return txt("No browser open.");
      const pages = context.pages().filter((p) => !p.isClosed());
      const lines = await Promise.all(
        pages.map(async (p, i) => {
          const mark = p === activePage ? "*" : " ";
          return `${mark}[${i}] ${await p.title().catch(() => "")} — ${p.url()}`;
        }),
      );
      return txt(`Tabs (* = active):\n${lines.join("\n")}`);
    },
  });

  // 15. switch tab
  pi.registerTool({
    name: "browser_switch_tab",
    label: "Switch Tab",
    description: "Make the tab at the given index active, then snapshot it.",
    parameters: Type.Object({
      index: Type.Number({ description: "Tab index from browser_tabs" }),
    }),
    async execute(_id, params) {
      await ensureBrowser();
      if (!context) return txt("No browser open.");
      const pages = context.pages().filter((p) => !p.isClosed());
      const target = pages[params.index];
      if (!target) return txt(`No tab at index ${params.index}.`);
      activePage = target;
      await target.bringToFront().catch(() => {});
      const snap = await takeSnapshot(target);
      return txt(`Switched to tab ${params.index}.\n\n${snap.text}`, { count: snap.count });
    },
  });

  // 16. back
  pi.registerTool({
    name: "browser_back",
    label: "Go Back",
    description: "Navigate back in history, then snapshot.",
    parameters: Type.Object({}),
    async execute() {
      const page = await ensureBrowser();
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
      const snap = await takeSnapshot(page);
      return txt(snap.text, { count: snap.count });
    },
  });

  // Convenience command to close the browser window.
  pi.registerCommand("browser-close", {
    description: "Close the automated browser window",
    handler: async (_args, ctx) => {
      await closeBrowser();
      ctx.ui.notify("Browser closed.", "info");
    },
  });
}
