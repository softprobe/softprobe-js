import { execFileSync } from "node:child_process";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { ConfigurationError } from "e2e/engine";
import type { SpanId, TraceId } from "../types.js";
import type { BrowserAttemptLedger } from "./correlator.js";

export interface CompletedProxyRequest {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly method: string;
  readonly url: string;
  readonly status?: number | undefined;
}

export interface MobileProxyAttemptContext {
  readonly ledger: BrowserAttemptLedger;
  readonly sessionId?: string | undefined;
  readonly onResponse?: ((entry: CompletedProxyRequest) => void) | undefined;
}

export interface StartMobileProxyOptions extends MobileProxyAttemptContext {
  readonly upstreamOrigin: string;
  readonly rejectUnauthorized?: boolean | undefined;
}

export interface MobileProxyHandle {
  readonly port: number;
  readonly proxyOrigin: string;
  readonly upstreamOrigin: string;
  setAttemptContext(context: MobileProxyAttemptContext): void;
  close(): Promise<void>;
}

export interface AdbReverseOptions {
  readonly port: number;
  readonly serial?: string | undefined;
  readonly adbBinary?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly runCommand?: ((file: string, args: readonly string[]) => void) | undefined;
}

export interface AdbReverseHandle {
  readonly port: number;
  readonly serial: string | undefined;
  cleanup(): void;
}

function parseUpstreamBaseUrl(rawOrigin: string): {
  readonly parsed: URL;
  readonly normalizedOrigin: string;
  readonly basePath: string;
} {
  if (typeof rawOrigin !== "string" || rawOrigin.trim() === "") {
    throw new ConfigurationError(
      "INVALID_CONFIG",
      "softprobeMobile proxy correlation requires a non-empty upstreamOrigin URL",
    );
  }
  const trimmed = rawOrigin.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConfigurationError(
      "INVALID_CONFIG",
      `Invalid softprobeMobile upstreamOrigin URL: ${JSON.stringify(rawOrigin)}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigurationError(
      "INVALID_CONFIG",
      `softprobeMobile upstreamOrigin must use http: or https:, got ${parsed.protocol}`,
    );
  }
  const basePath =
    parsed.pathname === "" || parsed.pathname === "/"
      ? ""
      : parsed.pathname.replace(/\/+$/, "");
  return {
    parsed,
    normalizedOrigin: `${parsed.origin}${basePath}`,
    basePath,
  };
}

export function mergeBaggageHeader(
  existing: string | undefined,
  sessionId: string | undefined,
): string | undefined {
  const cleanSessionId = sessionId?.trim();
  if (!cleanSessionId) {
    return existing;
  }
  const sessionMember = `sp.session.id=${cleanSessionId}`;
  if (!existing || existing.trim() === "") {
    return sessionMember;
  }
  const members = existing
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const filtered = members.filter((part) => {
    const eqIdx = part.indexOf("=");
    const key = (eqIdx >= 0 ? part.slice(0, eqIdx) : part).trim();
    return key !== "sp.session.id";
  });
  filtered.push(sessionMember);
  return filtered.join(",");
}

function flattenIncomingHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      flat[key] = value;
    } else if (Array.isArray(value)) {
      flat[key] = value.join(", ");
    }
  }
  return flat;
}

function buildTargetUrl(
  upstreamOriginObj: URL,
  basePath: string,
  rawRequestUrl: string | undefined,
): URL {
  const incoming = rawRequestUrl && rawRequestUrl.length > 0 ? rawRequestUrl : "/";
  let pathAndQuery: string;
  if (/^https?:\/\//i.test(incoming)) {
    const incomingUrl = new URL(incoming);
    pathAndQuery = `${incomingUrl.pathname}${incomingUrl.search}`;
  } else {
    const normalizedRel = incoming.startsWith("/") ? incoming : `/${incoming}`;
    pathAndQuery = normalizedRel.replace(/^\/{2,}/, "/");
  }

  const combinedPath =
    basePath === ""
      ? pathAndQuery
      : pathAndQuery === "/"
        ? basePath
        : `${basePath}${pathAndQuery}`;

  return new URL(combinedPath, upstreamOriginObj.origin);
}

function buildForwardHeaders(
  incoming: IncomingHttpHeaders,
  upstreamHost: string,
  mintedTraceparent: string | undefined,
  sessionId: string | undefined,
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  let existingBaggage: string | undefined;

  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === "host") {
      continue;
    }
    if (lower === "baggage") {
      existingBaggage = Array.isArray(value) ? value.join(", ") : value;
      continue;
    }
    if (lower === "traceparent" && mintedTraceparent !== undefined) {
      continue;
    }
    out[key] = value;
  }

  out["host"] = upstreamHost;
  if (mintedTraceparent !== undefined) {
    out["traceparent"] = mintedTraceparent;
  }
  const mergedBaggage = mergeBaggageHeader(existingBaggage, sessionId);
  if (mergedBaggage !== undefined) {
    out["baggage"] = mergedBaggage;
  }
  return out;
}

export async function startMobileProxy(
  options: StartMobileProxyOptions,
): Promise<MobileProxyHandle> {
  const { parsed: upstreamParsed, normalizedOrigin, basePath } = parseUpstreamBaseUrl(
    options.upstreamOrigin,
  );
  let activeContext: MobileProxyAttemptContext = {
    ledger: options.ledger,
    sessionId: options.sessionId,
    onResponse: options.onResponse,
  };

  const sockets = new Set<Socket>();
  let closePromise: Promise<void> | undefined;

  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const method = (req.method ?? "GET").toUpperCase();
    let targetUrl: URL;
    try {
      targetUrl = buildTargetUrl(upstreamParsed, basePath, req.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "invalid_proxy_request_url", message }));
      return;
    }

    const contextSnapshot = activeContext;
    const flatHeaders = flattenIncomingHeaders(req.headers);
    const recordOutcome =
      method === "OPTIONS"
        ? { existingHeaderPreserved: true as const }
        : contextSnapshot.ledger.recordRequest({
            method,
            url: targetUrl.href,
            headers: flatHeaders,
          });

    const mintedTraceparent = recordOutcome.existingHeaderPreserved
      ? undefined
      : recordOutcome.mintedTraceparent;
    const forwardHeaders = buildForwardHeaders(
      req.headers,
      targetUrl.host,
      mintedTraceparent,
      method === "OPTIONS" ? undefined : contextSnapshot.sessionId,
    );

    const requestFn = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;
    const upstreamReq = requestFn(
      targetUrl,
      {
        method,
        headers: forwardHeaders,
        ...(targetUrl.protocol === "https:" && options.rejectUnauthorized !== undefined
          ? { rejectUnauthorized: options.rejectUnauthorized }
          : {}),
      },
      (upstreamRes) => {
        const statusCode = upstreamRes.statusCode ?? 502;
        if (recordOutcome.recorded !== undefined) {
          contextSnapshot.onResponse?.({
            traceId: recordOutcome.recorded.traceId,
            spanId: recordOutcome.recorded.spanId,
            method: recordOutcome.recorded.method,
            url: recordOutcome.recorded.url,
            status: statusCode,
          });
        }
        res.writeHead(statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on("error", (error) => {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      const body = JSON.stringify({
        error: "bad_gateway",
        message: error.message,
      });
      res.writeHead(502, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
    });

    req.on("aborted", () => {
      upstreamReq.destroy();
    });

    req.pipe(upstreamReq);
  };

  const server: Server = createServer(handleRequest);
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("Expected numeric TCP address for mobile reverse proxy"));
        return;
      }
      const info: AddressInfo = addr;
      resolve(info.port);
    });
  });

  return {
    port,
    proxyOrigin: `http://127.0.0.1:${port}`,
    upstreamOrigin: normalizedOrigin,
    setAttemptContext(nextContext: MobileProxyAttemptContext): void {
      activeContext = nextContext;
    },
    close(): Promise<void> {
      if (closePromise !== undefined) {
        return closePromise;
      }
      closePromise = new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        for (const socket of sockets) {
          socket.destroy();
        }
      });
      return closePromise;
    },
  };
}

export function setupAndroidAdbReverse(options: AdbReverseOptions): AdbReverseHandle {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new ConfigurationError(
      "INVALID_CONFIG",
      `Invalid port for adb reverse: ${String(options.port)}`,
    );
  }
  const adbBinary = options.adbBinary?.trim() || "adb";
  const serial = options.serial?.trim() || undefined;
  const tcpSpec = `tcp:${options.port}`;
  const execRunner =
    options.runCommand ??
    ((file: string, args: readonly string[]) => {
      execFileSync(file, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        ...(options.env !== undefined ? { env: { ...process.env, ...options.env } } : {}),
      });
    });

  const basePrefix = serial !== undefined ? ["-s", serial] : [];
  execRunner(adbBinary, [...basePrefix, "reverse", tcpSpec, tcpSpec]);

  let cleaned = false;
  return {
    port: options.port,
    serial,
    cleanup(): void {
      if (cleaned) {
        return;
      }
      cleaned = true;
      try {
        execRunner(adbBinary, [...basePrefix, "reverse", "--remove", tcpSpec]);
      } catch {
        return;
      }
    },
  };
}
