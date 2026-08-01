/**
 * paste-image — VS Code Copilot Chat–style image paste for pi.
 *
 * Press the paste key (Alt+V on Windows, Ctrl+V elsewhere) or run `/paste`
 * with an image in your clipboard. Instead of dumping a temp-file PATH into
 * the editor (pi's built-in behavior), this captures the image as an
 * ATTACHMENT: a chip/thumbnail appears above the editor, your typed text stays
 * clean, and the image is sent WITH your next message — exactly like VS Code's
 * Copilot Chat.
 *
 * How it works
 *  - Capture: reads the OS clipboard image (Windows: PowerShell; macOS: pngpaste
 *    / AppleScript; Linux: wl-paste / xclip). No extra npm deps.
 *  - Preview: a widget above the editor shows each pending image (real inline
 *    thumbnail on Kitty/iTerm2/WezTerm/Ghostty; a clean text chip elsewhere,
 *    e.g. Windows Terminal, which has no terminal-image protocol).
 *  - Send: an `input` handler attaches the pending images to the outgoing user
 *    message (clean text) and clears the preview.
 *
 * Commands
 *  - /paste        Capture an image from the clipboard as an attachment.
 *  - /paste-clear  Discard pending image attachments.
 *  - /paste-send   Send pending images immediately (optional text argument).
 *
 * Shortcuts (override the built-in raw-path paste)
 *  - Windows: Alt+V and Ctrl+V     |  Other: Ctrl+V
 *  (On Windows Terminal, Ctrl+V is usually intercepted as terminal paste, so
 *   Alt+V is the reliable key. Remove Windows Terminal's Ctrl+V binding if you
 *   want literal Ctrl+V to reach pi.)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Image, getImageDimensions, getCapabilities, deleteKittyImage } from "@earendil-works/pi-tui";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WIDGET_KEY = "paste-image";
const SUPPORTED_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

type PendingImage = {
  id: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
  base64: string;
  width?: number;
  height?: number;
};

// ---------------------------------------------------------------------------
// Clipboard reading (self-contained, OS-native — no extra dependencies)
// ---------------------------------------------------------------------------

type RawImage = { bytes: Buffer; mimeType: string };

function run(
  command: string,
  args: string[],
  opts?: { timeoutMs?: number; input?: Buffer },
): { ok: boolean; stdout: Buffer } {
  try {
    const res = spawnSync(command, args, {
      timeout: opts?.timeoutMs ?? 5000,
      maxBuffer: 64 * 1024 * 1024,
      input: opts?.input,
      windowsHide: true,
    });
    if (res.error || res.status !== 0) return { ok: false, stdout: Buffer.alloc(0) };
    const stdout = Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout ?? "");
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: Buffer.alloc(0) };
  }
}

function extForMime(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}

/** Windows: use PowerShell to save the clipboard image to a temp PNG, then read it. */
function readClipboardImageWindows(): RawImage | null {
  const tmpFile = join(tmpdir(), `pi-paste-${randomUUID()}.png`);
  const psPath = tmpFile.replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$img = [System.Windows.Forms.Clipboard]::GetImage()",
    `if ($img) { $img.Save('${psPath}', [System.Drawing.Imaging.ImageFormat]::Png); 'ok' } else { 'empty' }`,
  ].join("; ");
  const res = run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeoutMs: 8000 },
  );
  if (!res.ok) return null;
  try {
    const bytes = readFileSync(tmpFile);
    if (bytes.length === 0) return null;
    return { bytes, mimeType: "image/png" };
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

/** macOS: prefer pngpaste, fall back to AppleScript writing «class PNGf» to a file. */
function readClipboardImageMac(): RawImage | null {
  const direct = run("pngpaste", ["-"], { timeoutMs: 4000 });
  if (direct.ok && direct.stdout.length > 0) {
    return { bytes: direct.stdout, mimeType: "image/png" };
  }
  const tmpFile = join(tmpdir(), `pi-paste-${randomUUID()}.png`);
  const script = [
    `set outFile to (POSIX file "${tmpFile}")`,
    "try",
    "  set pngData to (the clipboard as \u00abclass PNGf\u00bb)",
    "  set fh to open for access outFile with write permission",
    "  set eof fh to 0",
    "  write pngData to fh",
    "  close access fh",
    '  return "ok"',
    "on error",
    "  try",
    "    close access outFile",
    "  end try",
    '  return "empty"',
    "end try",
  ].flatMap((line) => ["-e", line]);
  const res = run("osascript", script, { timeoutMs: 6000 });
  if (!res.ok) return null;
  try {
    const bytes = readFileSync(tmpFile);
    if (bytes.length === 0) return null;
    return { bytes, mimeType: "image/png" };
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

/** Linux: try Wayland (wl-paste) then X11 (xclip). */
function readClipboardImageLinux(): RawImage | null {
  const wlTypes = run("wl-paste", ["--list-types"], { timeoutMs: 1500 });
  if (wlTypes.ok) {
    const types = wlTypes.stdout
      .toString("utf8")
      .split(/\r?\n/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const pick = SUPPORTED_MIME.find((m) => types.includes(m)) ?? types.find((t) => t.startsWith("image/"));
    if (pick) {
      const data = run("wl-paste", ["--type", pick, "--no-newline"], { timeoutMs: 4000 });
      if (data.ok && data.stdout.length > 0) return { bytes: data.stdout, mimeType: pick.split(";")[0] };
    }
  }
  for (const mime of SUPPORTED_MIME) {
    const data = run("xclip", ["-selection", "clipboard", "-t", mime, "-o"], { timeoutMs: 4000 });
    if (data.ok && data.stdout.length > 0) return { bytes: data.stdout, mimeType: mime };
  }
  return null;
}

function readClipboardImage(): RawImage | null {
  switch (process.platform) {
    case "win32":
      return readClipboardImageWindows();
    case "darwin":
      return readClipboardImageMac();
    default:
      return readClipboardImageLinux();
  }
}

// ---------------------------------------------------------------------------
// Preview widget (chip + optional inline thumbnail)
// ---------------------------------------------------------------------------

function humanSize(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1) return `${bytes} B`;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

class AttachmentsWidget {
  private images: (Image | undefined)[];
  constructor(
    private theme: { fg?: (role: string, s: string) => string } | undefined,
    private items: PendingImage[],
  ) {
    this.images = new Array(items.length).fill(undefined);
  }

  private style(s: string, role: "muted" | "accent" = "muted"): string {
    if (this.theme && typeof this.theme.fg === "function") {
      try {
        return this.theme.fg(role, s);
      } catch {
        /* fall through */
      }
    }
    return `\x1b[2m${s}\x1b[22m`; // dim
  }

  render(width: number): string[] {
    const caps = getCapabilities();
    const canThumb = Boolean(caps.images) && this.items.length <= 3;
    const n = this.items.length;
    const lines: string[] = [];
    lines.push(this.style(`\uD83D\uDCCE ${n} image${n === 1 ? "" : "s"} attached \u2014 will send with your message`, "accent"));
    this.items.forEach((it, i) => {
      const dims = it.width && it.height ? `${it.width}\u00d7${it.height}` : "";
      const meta = `${dims ? dims + "  \u00b7  " : ""}${humanSize(it.bytes.length)}`;
      lines.push(`${this.style(` #${i + 1}  `)}${it.filename}${this.style(`   ${meta}`)}`);
      if (canThumb) {
        try {
          if (!this.images[i]) {
            this.images[i] = new Image(
              it.base64,
              it.mimeType,
              { fallbackColor: (s: string) => this.style(s) },
              { maxWidthCells: 22, maxHeightCells: 6, filename: it.filename },
            );
          }
          for (const l of this.images[i]!.render(width)) lines.push(l);
        } catch {
          /* skip thumbnail on render error */
        }
      }
    });
    lines.push(this.style(`   Enter to send \u00b7 /paste-clear to remove \u00b7 /paste to add another`));
    return lines;
  }

  dispose(): void {
    for (const img of this.images) {
      const id = img?.getImageId?.();
      if (id !== undefined) {
        try {
          deleteKittyImage(id);
        } catch {
          /* ignore */
        }
      }
    }
    this.images = [];
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const pending: PendingImage[] = [];

  function refreshWidget(ctx: ExtensionContext): void {
    if (pending.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, theme) => new AttachmentsWidget(theme as { fg?: (role: string, s: string) => string }, pending.slice()),
      { placement: "aboveEditor" },
    );
  }

  function clearPending(ctx: ExtensionContext): void {
    pending.length = 0;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  function capture(ctx: ExtensionContext): void {
    let img: RawImage | null = null;
    try {
      img = readClipboardImage();
    } catch {
      img = null;
    }
    if (!img || img.bytes.length === 0) {
      ctx.ui.notify("No image found in the clipboard.", "warning");
      return;
    }
    const base64 = img.bytes.toString("base64");
    const dims = getImageDimensions(base64, img.mimeType);
    const item: PendingImage = {
      id: randomUUID(),
      filename: `pasted-${pending.length + 1}.${extForMime(img.mimeType)}`,
      mimeType: img.mimeType,
      bytes: img.bytes,
      base64,
      width: dims?.widthPx,
      height: dims?.heightPx,
    };
    pending.push(item);
    refreshWidget(ctx);
    const dimStr = item.width && item.height ? `${item.width}\u00d7${item.height}, ` : "";
    ctx.ui.notify(
      `Attached image #${pending.length} (${dimStr}${humanSize(item.bytes.length)}). Type a message and press Enter to send.`,
      "info",
    );
  }

  function toImageContent(p: PendingImage): ImageContent {
    return { type: "image", data: p.base64, mimeType: p.mimeType };
  }

  // Attach pending images to the next submitted message (clean text stays intact).
  pi.on("input", async (event, ctx) => {
    if (pending.length === 0) return { action: "continue" as const };
    // Don't double-attach for messages we send ourselves via /paste-send.
    if (event.source === "extension") return { action: "continue" as const };
    const images: ImageContent[] = [...(event.images ?? []), ...pending.map(toImageContent)];
    clearPending(ctx);
    return { action: "transform" as const, text: event.text, images };
  });

  pi.registerCommand("paste", {
    description: "Paste an image from the clipboard as an attachment (VS Code style)",
    handler: async (_args, ctx) => {
      capture(ctx);
    },
  });

  pi.registerCommand("paste-clear", {
    description: "Discard pending pasted-image attachments",
    handler: async (_args, ctx) => {
      if (pending.length === 0) {
        ctx.ui.notify("No pasted images to clear.", "info");
        return;
      }
      clearPending(ctx);
      ctx.ui.notify("Cleared pasted-image attachments.", "info");
    },
  });

  pi.registerCommand("paste-send", {
    description: "Send pending pasted images now (optional text argument)",
    handler: async (args, ctx) => {
      if (pending.length === 0) {
        ctx.ui.notify("No pasted images to send. Use /paste first.", "warning");
        return;
      }
      const text = (args ?? "").trim();
      const content: (ImageContent | { type: "text"; text: string })[] = [];
      if (text) content.push({ type: "text", text });
      for (const p of pending) content.push(toImageContent(p));
      clearPending(ctx);
      try {
        await pi.sendUserMessage(content as never);
      } catch (err) {
        ctx.ui.notify(`Failed to send images: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  // Keys that reliably reach pi. These override pi's built-in raw-path paste
  // (extension shortcuts are checked before the built-in pasteImage binding).
  const keys = process.platform === "win32" ? ["alt+v", "ctrl+v"] : ["ctrl+v"];
  for (const key of keys) {
    pi.registerShortcut(key, {
      description: "Paste image from clipboard as an attachment",
      handler: (ctx) => {
        capture(ctx);
      },
    });
  }
}
