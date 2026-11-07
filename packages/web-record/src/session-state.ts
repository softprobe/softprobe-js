import type { SessionProvider } from "@opentelemetry/browser-sdk/session";

/** The mutable session source shared by OTel spans and the recorder. */
export type WebSessionState = SessionProvider & {
  setSessionId: (sessionId: string) => void;
};

export function createWebSessionState(initialSessionId: string): WebSessionState {
  let sessionId = initialSessionId;
  return {
    getSessionId: () => sessionId,
    setSessionId: (nextSessionId) => {
      sessionId = nextSessionId;
    },
  };
}
