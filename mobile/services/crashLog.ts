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
      try {
        debugLog("crash", `${isFatal ? "fatal" : "error"}: ${describeError(error)}`);
      } catch {
        // The error still has to reach the usual handler below.
      }
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
        onUnhandled: (_id, rejection) => {
          try {
            debugLog("crash", `unhandled promise rejection: ${describeError(rejection)}`);
          } catch {
            // Nothing useful can be said about it.
          }
        },
      });
    } catch {
      // Not available on this engine.
    }
  }

  for (const level of ["error", "warn"] as const) {
    try {
      const original = console[level].bind(console);
      let last = "";
      console[level] = (...args: unknown[]) => {
        try {
          const line = args.map(text).join(" ");
          // A library that warns on every render must not push everything else out of the log.
          if (line !== last) debugLog(`console.${level}`, line);
          last = line;
        } catch {
          // Whatever was passed could not be turned into text. The console still gets it.
        }
        original(...args);
      };
    } catch {
      // Leave the console as it is.
    }
  }
}

installCrashLog();
