/**
 * QQ TUI login interface.
 *
 * Handles the interactive QR code login flow for QQ native authentication.
 * Displays QR codes in the terminal and manages login state transitions.
 *
 * This module is used when QQ is configured with native login (via oicq2/libQQ)
 * rather than an external OneBot 11 backend.
 *
 * SSH remote note: when running over SSH without a local terminal, QR codes are
 * written to a file and the user is given a path to download/copy it.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  intro as clackIntro,
  note as clackNote,
  outro as clackOutro,
  spinner as clackSpinner,
} from "@clack/prompts";
import { stylePromptTitle } from "openclaw/plugin-sdk/cli-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";

/** QR code data format from oicq2 login events. */
export type QqQrCodeData = {
  /** Base64-encoded QR code image data. */
  imageData?: string;
  /** Raw QR code string (for ASCII rendering). */
  qrcode?: string;
  /** URL for scanning the QR code on mobile. */
  url?: string;
};

export type QqLoginState =
  | { phase: "waiting" }
  | { phase: "qr-received"; qr: QqQrCodeData }
  | { phase: "scanned" }
  | { phase: "confirming" }
  | { phase: "connected"; userId: number }
  | { phase: "error"; message: string };

export type QqTuiCallbacks = {
  /** Called when the TUI wants to start the login process. */
  onStartLogin: () => void;
  /** Called when the user cancels the login flow. */
  onCancel: () => void;
};

export type QqTuiOptions = {
  runtime: RuntimeEnv;
  /** Called with the final logged-in user ID on success. */
  onSuccess: (userId: number) => void;
  /** Called when login fails or is cancelled. */
  onFailure: (reason?: string) => void;
};

/** Detect if we're running in a non-interactive environment. */
function isNonInteractive(): boolean {
  return !process.stdin.isTTY || !process.stdout.isTTY;
}

/**
 * Write QR code as ASCII art to the terminal using qrcode-terminal.
 * Falls back to writing a text file when in SSH/non-TTY mode.
 */
async function renderQrToTerminal(
  qr: QqQrCodeData,
  runtime: RuntimeEnv,
): Promise<boolean> {
  // Dynamic import to avoid loading qrcode-terminal in non-interactive contexts.
  // qrcode-terminal uses the terminal's columns/rows to size the QR code.
  if (!process.stdout.isTTY) {
    return false;
  }

  try {
    const { default: qrcodeTerminal } = await import("qrcode-terminal");
    if (qr.qrcode) {
      qrcodeTerminal.generate(qr.qrcode, { small: true });
    } else if (qr.imageData) {
      // oicq2 sometimes provides imageData as base64 PNG.
      // Validate and write to temp file.
      const base64Match = qr.imageData.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!base64Match) {
        runtime.log(`Invalid QR image data format`);
        return false;
      }
      const [, mimeType, base64Data] = base64Match;
      const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? "/tmp";
      const tmpPath = path.join(tmpDir, `openclaw-qq-login-${Date.now()}.${mimeType}`);
      try {
        const imageBuffer = Buffer.from(base64Data, "base64");
        if (imageBuffer.length < 100) {
          runtime.log(`QR image data too small, likely invalid`);
          return false;
        }
        fs.writeFileSync(tmpPath, imageBuffer);
        runtime.log(`QR code saved to: ${tmpPath}`);
        console.log(`\n  QR code image written to:\n  ${tmpPath}\n  Open this file in your mobile QQ app to scan.\n`);
      } catch (writeErr) {
        runtime.log(`Failed to write QR image: ${String(writeErr)}`);
        return false;
      }
    }
    return true;
  } catch (err) {
    runtime.log(`QR render error: ${String(err)}`);
    return false;
  }
}

/**
 * Show a status note to the user using @clack/prompts.
 */
function showStatusNote(message: string, title?: string): void {
  clackNote(message, stylePromptTitle(title ?? "QQ Login"));
}

async function waitForState(
  getState: () => QqLoginState,
  opts: {
    timeoutMs: number;
    pollIntervalMs?: number;
    runtime: RuntimeEnv;
  },
): Promise<QqLoginState> {
  const { timeoutMs, pollIntervalMs = 500 } = opts;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = getState();
    if (state.phase !== "waiting" && state.phase !== "qr-received") {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return { phase: "error", message: "Login timed out" };
}

/**
 * Main TUI login flow using @clack/prompts.
 *
 * The flow is:
 *  1. Show intro screen
 *  2. Start the login process (via onStartLogin callback)
 *  3. Wait for QR code event
 *  4. Display QR code (TTY: ASCII art, non-TTY: file + note)
 *  5. Wait for scan → confirm → connected
 *  6. Show success/error outro
 *
 * @param stateAccessor - function that returns the current login state
 * @param callbacks - callbacks for user actions
 * @param opts - runtime and success/failure handlers
 */
export async function runQqLoginTui(
  stateAccessor: () => QqLoginState,
  callbacks: QqTuiCallbacks,
  opts: QqTuiOptions,
): Promise<void> {
  const { runtime, onSuccess, onFailure } = opts;

  if (isNonInteractive()) {
    await runNonInteractiveLogin(stateAccessor, callbacks, opts);
    return;
  }

  // Interactive TTY mode
  clackIntro(stylePromptTitle("QQ Login"));

  const spin = clackSpinner();
  spin.start("Starting QQ login...");

  callbacks.onStartLogin();

  // Wait for QR code to arrive (oicq2 emits it after a short delay)
  const qrState = await waitForState(stateAccessor, {
    timeoutMs: 30_000,
    pollIntervalMs: 300,
    runtime,
  });

  if (qrState.phase === "error") {
    spin.stop("Login failed");
    showStatusNote(qrState.message, "Error");
    onFailure(qrState.message);
    return;
  }

  if (qrState.phase === "qr-received") {
    spin.stop("QR code ready");
    await renderQrToTerminal(qrState.qr, runtime);

    showStatusNote(
      [
        "Open QQ on your phone.",
        "Navigate to: Settings → About → Scan QR Code",
        "Scan the QR code above to log in.",
      ].join("\n"),
      "Scan QR Code",
    );
  }

  // Wait for login to complete (scanned → confirmed → connected)
  const finalState = await waitForState(stateAccessor, {
    timeoutMs: 120_000,
    pollIntervalMs: 500,
    runtime,
  });

  spin.stop("");

  if (finalState.phase === "connected") {
    runtime.log(`QQ logged in as user ${finalState.userId}`);
    clackOutro(stylePromptTitle(`Logged in as ${finalState.userId}`));
    onSuccess(finalState.userId);
    return;
  }

  if (finalState.phase === "error") {
    showStatusNote(finalState.message, "Login Failed");
    onFailure(finalState.message);
    return;
  }

  // Cancelled or unexpected state
  onFailure();
}

/**
 * Non-interactive (SSH/remote) login flow.
 *
 * Instead of displaying an ASCII QR code, we write the QR image data to a file
 * and provide instructions for the user to transfer it to their mobile device.
 */
async function runNonInteractiveLogin(
  stateAccessor: () => QqLoginState,
  callbacks: QqTuiCallbacks,
  opts: QqTuiOptions,
): Promise<void> {
  const { runtime, onSuccess, onFailure } = opts;

  runtime.log("[QQ] Starting non-interactive login...");
  callbacks.onStartLogin();

  const qrState = await waitForState(stateAccessor, {
    timeoutMs: 30_000,
    pollIntervalMs: 500,
    runtime,
  });

  if (qrState.phase === "error") {
    runtime.error(`[QQ] Login error: ${qrState.message}`);
    onFailure(qrState.message);
    return;
  }

  if (qrState.phase === "qr-received") {
    await showQrNonInteractive(qrState.qr, runtime);
  }

  const finalState = await waitForState(stateAccessor, {
    timeoutMs: 120_000,
    pollIntervalMs: 500,
    runtime,
  });

  if (finalState.phase === "connected") {
    runtime.log(`[QQ] Logged in as user ${finalState.userId}`);
    onSuccess(finalState.userId);
    return;
  }

  if (finalState.phase === "error") {
    runtime.error(`[QQ] Login failed: ${finalState.message}`);
    onFailure(finalState.message);
    return;
  }

  onFailure();
}

/**
 * Display QR code for non-interactive/SSH mode.
 * Writes the QR image to a file and logs the path.
 */
async function showQrNonInteractive(qr: QqQrCodeData, runtime: RuntimeEnv): Promise<void> {
  runtime.log("[QQ] QR code login initiated.");

  if (qr.url) {
    runtime.log(`[QQ] Login URL: ${qr.url}`);
  }

  if (qr.imageData) {
    const base64Match = qr.imageData.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!base64Match) {
      runtime.error("[QQ] Invalid QR image data format");
    } else {
      const [, mimeType, base64Data] = base64Match;
      const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? "/tmp";
      const tmpPath = path.join(tmpDir, `openclaw-qq-login-${Date.now()}.${mimeType}`);
      try {
        const imageBuffer = Buffer.from(base64Data, "base64");
        if (imageBuffer.length < 100) {
          runtime.error("[QQ] QR image data too small, likely invalid");
        } else {
          fs.writeFileSync(tmpPath, imageBuffer);
          runtime.log(`[QQ] QR code image saved to: ${tmpPath}`);
          runtime.log(`[QQ] Transfer this file to your mobile device and scan with QQ.`);
        }
      } catch (err) {
        runtime.error(`[QQ] Failed to save QR image: ${String(err)}`);
      }
    }
  } else if (qr.qrcode) {
    runtime.log("[QQ] QR code string available — run locally with a TTY to see ASCII QR.");
  }

  runtime.log("[QQ] Waiting for scan... (this may take up to 2 minutes)");
}
