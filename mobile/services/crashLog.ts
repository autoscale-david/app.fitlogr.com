import { debugLog, describeError, flushDebugLog } from "./debugLog";

/**
 * Sends crashes, rejected promises and console errors to the debug log. A build on a real iPhone has
 * no console anyone can read, so without this they vanish. Imported once, by the root layout.
 */
interface ErrorUtilsLike {
  getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
  setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
}

interface HermesLike {
  enablePromiseRejectionTracker?: (options: { allRejections: boolean; onUnhandled: (id: number, rejection: unknown) => void }) => void;
}

function text(value: unknown): string {
  if (value instanceof Error) return describeError(value);
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

let installed = false;

export function installCrashLog(): void {
  if (installed) return;
  installed = true;
  const scope = globalThis as unknown as { ErrorUtils?: ErrorUtilsLike; HermesInternal?: HermesLike };

  try {
    const previous = scope.ErrorUtils?.getGlobalHandler?.();
    scope.ErrorUtils?.setGlobalHandler?.((error, isFatal) => {
      debugLog("crash", `${isFatal ? "fatal" : "error"}: ${describeError(error)}`);
      if (!isFatal) {
        void flushDebugLog();
        previous?.(error, isFatal);
        return;
      }
      // The usual handler ends a release app at once. Give the line half a second to reach disk first.
      let passedOn = false;
      const passOn = () => {
        if (passedOn) return;
        passedOn = true;
        previous?.(error, isFatal);
      };
      setTimeout(passOn, 500);
      void flushDebugLog().then(passOn, passOn);
    });
  } catch {
    // The app runs the same without it.
  }

  if (!__DEV__) {
    try {
      // In development React Native reports these itself. A release build drops them silently.
      scope.HermesInternal?.enablePromiseRejectionTracker?.({
        allRejections: true,
        onUnhandled: (_id, rejection) => debugLog("crash", `unhandled promise rejection: ${describeError(rejection)}`),
      });
    } catch {
      // Not available on this engine.
    }
  }

  for (const level of ["error", "warn"] as const) {
    try {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        debugLog(`console.${level}`, args.map(text).join(" "));
        original(...args);
      };
    } catch {
      // Leave the console as it is.
    }
  }
}

installCrashLog();
