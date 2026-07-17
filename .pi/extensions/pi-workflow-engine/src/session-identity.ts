import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Stable identity for state retained for the lifetime of a pi session. */
export function sessionKey(ctx: Pick<ExtensionContext, "sessionManager">): string {
  return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
}
