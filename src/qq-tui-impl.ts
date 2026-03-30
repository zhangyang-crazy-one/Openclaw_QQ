/**
 * QQ TUI integration for native login.
 *
 * This module bridges qq-native.ts login events with qq-tui.ts TUI display.
 * It is loaded lazily to avoid hard dependency on @clack/prompts when not needed.
 */

import { getLoginState, setLoginState } from "./qq-native.js";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";

export type { QqLoginState, QqQrCodeData } from "./qq-tui.js";

/**
 * Adapt qq-native login state to qq-tui QqLoginState format.
 */
function toTuiState(nativeState: ReturnType<typeof getLoginState>): import("./qq-tui.js").QqLoginState {
  if (nativeState.phase === "qr-received") {
    return { phase: "qr-received", qr: { qrcode: nativeState.qrcode, imageData: nativeState.imageData, url: nativeState.url } };
  }
  if (nativeState.phase === "connected") {
    return { phase: "connected", userId: nativeState.userId };
  }
  if (nativeState.phase === "error") {
    return { phase: "error", message: nativeState.message };
  }
  return { phase: nativeState.phase };
}

/**
 * Start the TUI login flow for a QQ native account.
 *
 * This should be called after startQqNativeClient() when using QR login.
 * It will display the QR code and wait for login to complete.
 *
 * @param accountId - The account ID
 * @param runtime - OpenClaw runtime environment
 * @param onSuccess - Called when login succeeds with the user ID
 * @param onFailure - Called when login fails or is cancelled
 */
export async function runNativeLoginTui(
  accountId: string,
  runtime: RuntimeEnv,
  onSuccess: (userId: number) => void,
  onFailure: (reason?: string) => void,
): Promise<void> {
  // Lazily import the TUI module to avoid loading @clack/prompts when not needed
  const { runQqLoginTui } = await import("./qq-tui.js");

  const stateAccessor = () => toTuiState(getLoginState(accountId));

  await runQqLoginTui(
    stateAccessor,
    {
      onStartLogin: () => {
        runtime.log(`[QQ] Login process started for account ${accountId}`);
      },
      onCancel: () => {
        runtime.log(`[QQ] Login cancelled for account ${accountId}`);
        setLoginState(accountId, { phase: "error", message: "Login cancelled by user" });
      },
    },
    {
      runtime,
      onSuccess,
      onFailure,
    },
  );
}
