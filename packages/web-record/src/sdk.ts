import { EventType, type eventWithTime } from "@rrweb/types";
import { pack, record as rrwebRecord } from "rrweb";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  asNonEmptyString,
  deriveOtlpEndpoint,
  resolveSoftprobeConfigFromObject,
  MissingSoftprobeCredentialsError,
} from "@softprobe/tracing/config";
import { createBrowserRuntime, type BrowserRuntime } from "./browser-runtime.js";
import { createWebSessionState } from "./session-state.js";
import type {
  RecordingHandle,
  RecordingUploadStatus,
  RrwebEventBatchItem,
  Tags,
  WebRecordController,
  WebRecordInitOptions,
} from "./types.js";

const MAX_EVENTS = 500;
/** 连续导出失败多少次后彻底放弃采集(见 {@link RecordSdk.noteExportFailure})。 */
const MAX_CONSECUTIVE_EXPORT_FAILURES = 5;
/** 退避上限。不可达时不应一直定期打点。 */
const BACKOFF_MAX_MS = 5 * 60_000;
const COOKIE_NAME = "_sp_vid";
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
const SESSION_ID_STORAGE_PREFIX = "_sp_session_id:";
const RECORDING_SPAN_NAME = "softprobe.web.recording";
const RECORDING_EVENT_NAME = "sp.recording.batch";
const RECORDING_EVENTS_ATTRIBUTE = "sp.recording.events";

type Compressible = eventWithTime & {
  data?: unknown;
  isCompressed?: boolean;
  eventIndex?: number;
};

export class RecordSdk implements WebRecordController {
  readonly enabled: boolean;
  private _sessionId: string;
  private readonly otlpEndpoint: string;
  private readonly apiKey: string;
  private readonly apiOrigins: string[];
  private readonly sessionIdStorageKey: string;
  private readonly intervalMs: number;
  private readonly serviceName?: string;
  private readonly environment?: string;
  private readonly userId?: string;
  private readonly maskAllInputs: boolean;
  private readonly maskTextSelector?: string;
  private readonly blockSelector?: string;
  private readonly onUploadStatus?: (status: RecordingUploadStatus) => void;
  private readonly recordOptions: Record<string, unknown>;
  private readonly replacers: Record<string, string>;
  private readonly browserRuntime: BrowserRuntime | null;
  private tags: Tags;
  private events: RrwebEventBatchItem[] = [];
  private eventIndex = 0;
  private lastSnapshotIndex = 0;
  private batchIndex = 0;
  private visitorId: string;
  private systemInfo: Record<string, string | number | null> | null = null;
  private stopHandle: RecordingHandle | null = null;
  private saving = false;
  private recordingFlush: Promise<boolean> | null = null;
  /** 连续导出失败次数;成功即归零。 */
  private consecutiveFailures = 0;
  /** 退避到期时间戳(ms);在此之前定时器不再尝试导出。 */
  private nextAttemptAt = 0;
  /** 熔断标志:连败到上限后置位,导出与采集一起停。 */
  private exportDisabled = false;
  /** Serializes setSessionId drains so overlapping navigations cannot race. */
  private sessionSwitch: Promise<void> = Promise.resolve();
  private _uploadStatus: RecordingUploadStatus = "idle";
  private readonly onPageHide = (): void => {
    if (!this.enabled || (
      this.events.length === 0 && !this.saving && !this.browserRuntime?.hasPendingTelemetry()
    )) return;
    this.setUploadStatus("incomplete");
    if (!this.saving) void this.flushInternal(true);
  };

  private constructor(
    options: WebRecordInitOptions & { enabled: boolean; otlpEndpoint: string },
  ) {
    this.enabled = options.enabled;
    this.apiKey = options.apiKey ?? options.publicKey ?? "";
    this.apiOrigins = [...(options.apiOrigins ?? [])];
    this.otlpEndpoint = options.otlpEndpoint;
    this.sessionIdStorageKey = `${SESSION_ID_STORAGE_PREFIX}${options.serviceName ?? "default"}`;
    this._sessionId = getOrCreateSessionId(options.sessionId, this.sessionIdStorageKey);
    this.intervalMs = Math.max(options.interval ?? 5000, 5000);
    this.serviceName = options.serviceName;
    this.environment = options.environment;
    this.userId = options.userId;
    this.maskAllInputs = options.maskAllInputs !== false;
    this.maskTextSelector = options.maskTextSelector;
    this.blockSelector = options.blockSelector;
    this.onUploadStatus = options.onUploadStatus;
    this.recordOptions = options.recordOptions ?? {};
    this.replacers = options.replacers ?? {};
    this.tags = { ...(options.tags ?? {}) };
    if (this.userId && !this.tags.userId) this.tags.userId = this.userId;
    this.visitorId = getOrCreateVisitorId();
    const sessionState = this.enabled ? createWebSessionState(this._sessionId) : null;
    this.browserRuntime = this.enabled && sessionState
      ? createBrowserRuntime({
          apiKey: this.apiKey,
          otlpEndpoint: this.otlpEndpoint,
          serviceName: this.serviceName,
          environment: this.environment,
          apiOrigins: this.apiOrigins,
          httpBodyCapture: options.httpBodyCapture,
        }, sessionState)
      : null;

    if (this.enabled) {
      if (!options.manual) {
        this.record();
      }
    }
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get uploadStatus(): RecordingUploadStatus {
    return this._uploadStatus;
  }

  static init(options: WebRecordInitOptions = {} as WebRecordInitOptions): WebRecordController {
    const softDisable = options.softDisable !== false;
    try {
      const resolved = resolveSoftprobeConfigFromObject({
        publicKey: options.apiKey ?? options.publicKey,
        baseUrl: options.baseUrl,
        otlpEndpoint: options.otlpEndpoint,
        environment: options.environment,
        userId: options.userId,
        serviceName: options.serviceName ?? "softprobe-web",
      });
      return new RecordSdk({
        ...options,
        publicKey: resolved.publicKey,
        baseUrl: resolved.baseUrl,
        otlpEndpoint: resolved.otlpEndpoint,
        environment: resolved.environment,
        userId: resolved.userId,
        serviceName: resolved.serviceName,
        enabled: true,
      });
    } catch (err) {
      if (softDisable && err instanceof MissingSoftprobeCredentialsError) {
        console.warn(
          "[@softprobe/web-record] Softprobe credentials missing; recording disabled.",
        );
        return new RecordSdk({
          publicKey: "",
          baseUrl: "",
          otlpEndpoint: deriveOtlpEndpoint("http://127.0.0.1"),
          enabled: false,
          manual: true,
        });
      }
      throw err;
    }
  }

  record(opts?: { tags?: Tags }): RecordingHandle | null {
    if (!this.enabled) return null;
    // 熔断后不再重新武装。宿主(SPA)每次路由变化都会调 record(),不挡住的话
    // 每导航一次就白起一轮 rrweb 采集,下一个 tick 再自己停掉。
    if (this.exportDisabled) return null;
    if (this.stopHandle) return this.stopHandle;

    if (opts?.tags) this.setTags(opts.tags);

    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", this.onPageHide);
    }

    const stopFn = rrwebRecord({
      maskAllInputs: this.maskAllInputs,
      ...this.recordOptions,
      ...(this.maskTextSelector ? { maskTextSelector: this.maskTextSelector } : {}),
      ...(this.blockSelector ? { blockSelector: this.blockSelector } : {}),
      emit: (raw: unknown) => {
        const event = raw as eventWithTime;
        if (this.events.length >= MAX_EVENTS) this.events.shift();
        const withIndex = this.compressEvent({
          ...event,
          eventIndex: ++this.eventIndex,
        } as Compressible);
        this.events.push(withIndex as RrwebEventBatchItem);
      },
    } as Parameters<typeof rrwebRecord>[0]);

    const intervalId = setInterval(() => {
      // 熔断后连采集一起停:导出不出去还继续录,只是白耗主线程和内存。
      if (this.exportDisabled) {
        this.stop();
        return;
      }
      // 退避未到,这轮跳过。这里刻意不打日志——日志本身就是故障放大器。
      if (Date.now() < this.nextAttemptAt) return;
      void this.flush();
      if (this.events.length) {
        const last = this.events[this.events.length - 1];
        const lastIndex = Number(last?.eventIndex ?? 0);
        if (this.lastSnapshotIndex + 50 < lastIndex) {
          rrwebRecord.takeFullSnapshot();
          this.lastSnapshotIndex = lastIndex;
        }
      }
    }, this.intervalMs);

    this.stopHandle = {
      stop: () => {
        clearInterval(intervalId);
        if (typeof window !== "undefined") {
          window.removeEventListener("pagehide", this.onPageHide);
        }
        stopFn?.();
        void this.flush();
        this.stopHandle = null;
      },
    };
    return this.stopHandle;
  }

  stop(): void {
    this.stopHandle?.stop();
  }

  setTags(tags: Tags, override = false): void {
    this.tags = override ? { ...tags } : { ...this.tags, ...tags };
  }

  setSessionId(sessionId: string): Promise<void> {
    const next = asNonEmptyString(sessionId);
    if (!next || next === this._sessionId) return Promise.resolve();
    // Serialize switches so overlapping navigations cannot race the drain.
    this.sessionSwitch = this.sessionSwitch
      .catch(() => undefined)
      .then(() => this.switchSessionId(next));
    return this.sessionSwitch;
  }

  private async switchSessionId(next: string): Promise<void> {
    await this.drainFlush();
    this._sessionId = next;
    this.browserRuntime?.setSessionId(next);
    try {
      if (typeof sessionStorage !== "undefined") {
        sessionStorage.setItem(this.sessionIdStorageKey, next);
      }
    } catch {
      // Storage can be unavailable in restricted browser contexts.
    }
  }

  /**
   * Wait out in-flight exports, then flush until the buffer is empty.
   * Stops after a failed flush so we do not spin forever when OTLP is down
   * (events stay queued under the old session for a later attempt / stop).
   */
  private async drainFlush(): Promise<void> {
    for (;;) {
      while (this.saving) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      const pendingSpans = this.browserRuntime?.hasPendingTelemetry() ?? false;
      if (this.events.length === 0 && !pendingSpans) return;
      const before = this.events.length;
      const ok = await this.flush();
      if (!ok) return;
      if (this.events.length >= before && !this.browserRuntime?.hasPendingTelemetry()) return;
    }
  }

  compressEvent(event: Compressible): Compressible {
    if (event.type === EventType.FullSnapshot) {
      try {
        const compressedData = pack(event.data as never);
        return {
          type: event.type,
          data: compressedData,
          timestamp: event.timestamp,
          isCompressed: true,
          eventIndex: event.eventIndex,
        } as Compressible;
      } catch (e) {
        console.error("Failed to compress FullSnapshot:", e);
      }
    }
    return event;
  }

  flush(): Promise<boolean> {
    return this.flushInternal(false);
  }

  private async flushInternal(preserveIncompleteStatus: boolean): Promise<boolean> {
    if (this.exportDisabled) return false;
    if (!this.enabled) return true;
    if (this.saving) {
      return this.recordingFlush ?? false;
    }
    if (!this.browserRuntime) return true;
    const flushPromise = this.flushOtlp(preserveIncompleteStatus);
    this.recordingFlush = flushPromise;
    try {
      return await flushPromise;
    } finally {
      if (this.recordingFlush === flushPromise) this.recordingFlush = null;
    }
  }

  private async flushOtlp(preserveIncompleteStatus: boolean): Promise<boolean> {
    this.saving = true;
    const batch = this.events.splice(0, this.events.length);
    const batchIndex = this.batchIndex;
    const hadTelemetry = batch.length > 0 || this.browserRuntime?.hasPendingTelemetry() === true;
    let spanEnded = false;
    try {
      if (hadTelemetry && !preserveIncompleteStatus) {
        this.setUploadStatus("pending");
      }
      if (batch.length > 0) {
        if (!this.systemInfo) this.systemInfo = await this.collectSystemInfo();
        const attributes: Record<string, string | number | boolean> = {};
        for (const [key, value] of Object.entries({ ...this.systemInfo, ...this.tags })) {
          const resolved = this.replacers[key] || value;
          if (typeof resolved === "string" || typeof resolved === "number" || typeof resolved === "boolean") {
            attributes[key] = resolved;
          }
        }
        const now = Date.now();
        const firstTimestamp = batch[0]?.timestamp;
        const startTime = new Date(typeof firstTimestamp === "number" ? firstTimestamp : now);
        const endTime = new Date(now);
        const span = this.browserRuntime!.tracer.startSpan(RECORDING_SPAN_NAME, {
          startTime,
          attributes: {
            ...attributes,
            "sp.observation.type": "recording",
            "sp.recording.batch_index": batchIndex,
          },
        });
        try {
          span.addEvent(RECORDING_EVENT_NAME, {
            [RECORDING_EVENTS_ATTRIBUTE]: JSON.stringify(batch),
          }, endTime);
          span.setStatus({ code: SpanStatusCode.OK });
        } finally {
          span.end(endTime);
          spanEnded = true;
        }
      }

      await this.browserRuntime!.waitForIdle();
      await this.browserRuntime!.forceFlush();
      if (batch.length > 0) this.batchIndex = batchIndex + 1;
      this.consecutiveFailures = 0;
      this.nextAttemptAt = 0;
      if (hadTelemetry) this.setUploadStatus("uploaded");
      return true;
    } catch (error) {
      if (batch.length > 0) this.events.unshift(...batch);
      this.setUploadStatus("failed");
      if (batch.length > 0 || spanEnded) this.noteExportFailure(error);
      return false;
    } finally {
      this.saving = false;
    }
  }

  private setUploadStatus(status: RecordingUploadStatus): void {
    this._uploadStatus = status;
    try {
      this.onUploadStatus?.(status);
    } catch {
      // Application status rendering must not interrupt recording or export.
    }
  }


  /**
   * 导出失败后的退避与熔断。
   *
   * <p>现场实证(2026-08-25,甲方内网):到不了配置的 collector,原实现每 5 秒把同一批
   * 事件原样重发,失败 429 次没停过 —— 控制台被刷爆,主线程每轮还白做一次
   * `JSON.stringify` + 压缩,页面肉眼可见地卡。三条对策:
   * <ul>
   *   <li>连败指数退避,不再固定间隔硬打;</li>
   *   <li>只在连败的<b>第一条</b>打日志,后续静默;</li>
   *   <li>连败到上限就停掉采集并清空缓冲,再打一条写明端点和处置办法。</li>
   * </ul>
   * 单次失败仍然保留缓冲(可能只是网络抖动),这一点不变。
   */
  private noteExportFailure(error: unknown): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures === 1) {
      console.error(
        "[@softprobe/web-record] Failed to flush recording:",
        error,
      );
    }
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_EXPORT_FAILURES) {
      this.exportDisabled = true;
      this.events.length = 0;
      console.error(
        `[@softprobe/web-record] Giving up after ${this.consecutiveFailures} ` +
          `consecutive export failures; session recording disabled. ` +
          `Endpoint: ${this.otlpEndpoint}. On a closed network, point ` +
          `SOFTPROBE_BASE_URL at a reachable collector or disable web recording.`,
      );
      return;
    }
    this.nextAttemptAt =
      Date.now() +
      Math.min(
        BACKOFF_MAX_MS,
        this.intervalMs * 2 ** (this.consecutiveFailures - 1),
      );
  }

  private async collectSystemInfo(): Promise<
    Record<string, string | number | null>
  > {
    let ua = "";
    let os = "Unknown";
    let osVersion = "Unknown";
    let browser = "Unknown";
    let browserVersion = "Unknown";
    let cpu = "Unknown";
    let device = "desktop";
    try {
      const { UAParser } = await import("ua-parser-js");
      const parser = new UAParser();
      const result = await parser.getResult().withClientHints();
      ua = result.ua;
      os = result.os.name || "Unknown";
      osVersion = result.os.version || "Unknown";
      browser = result.browser.name || "Unknown";
      browserVersion = result.browser.version || "Unknown";
      cpu = result.cpu.architecture || "Unknown";
      device = result.device.type || "desktop";
    } catch {
      ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    }

    return {
      _sp_ua: ua,
      _sp_url:
        typeof window !== "undefined"
          ? window.location.hostname + window.location.pathname
          : "",
      _sp_search: typeof window !== "undefined" ? window.location.search : "",
      _sp_referer:
        typeof document !== "undefined" ? document.referrer || null : null,
      _sp_os: os,
      _sp_osVersion: osVersion,
      _sp_browser: browser,
      _sp_browserVersion: browserVersion,
      _sp_cpu: cpu,
      _sp_device: device,
      _sp_width: typeof window !== "undefined" ? window.innerWidth : 0,
      _sp_height: typeof window !== "undefined" ? window.innerHeight : 0,
      _sp_scrollWidth:
        typeof document !== "undefined"
          ? document.documentElement.scrollWidth
          : 0,
      _sp_scrollHeight:
        typeof document !== "undefined"
          ? document.documentElement.scrollHeight
          : 0,
      _sp_vid: this.visitorId,
    };
  }
}

function uuid(): string {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => {
    const n = Number(c);
    return (
      n ^
      (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (n / 4)))
    ).toString(16);
  });
}

function getOrCreateSessionId(candidate: unknown, storageKey: string): string {
  const provided = asNonEmptyString(candidate);
  try {
    if (typeof sessionStorage !== "undefined") {
      if (provided) {
        sessionStorage.setItem(storageKey, provided);
        return provided;
      }
      const stored = asNonEmptyString(sessionStorage.getItem(storageKey));
      if (stored) return stored;
      const generated = uuid();
      sessionStorage.setItem(storageKey, generated);
      return generated;
    }
  } catch {
    // sessionStorage may throw for blocked or opaque origins; use an in-memory ID.
  }
  return provided ?? uuid();
}

function getOrCreateVisitorId(): string {
  if (typeof document === "undefined") return uuid();
  const existing = getCookie(COOKIE_NAME);
  if (existing) return existing;
  const id = uuid();
  setCookie(COOKIE_NAME, id);
  return id;
}

function setCookie(name: string, value: string): void {
  try {
    const isLocalhost =
      typeof window !== "undefined" && window.location.hostname === "localhost";
    const parts = [
      `${name}=${encodeURIComponent(value)}`,
      `max-age=${COOKIE_MAX_AGE}`,
      "path=/",
    ];
    if (!isLocalhost && typeof window !== "undefined") {
      const host = window.location.hostname;
      const base = host.split(".").slice(-2).join(".");
      parts.push(`domain=.${base}`, "SameSite=None", "Secure");
    }
    document.cookie = parts.join("; ");
  } catch {
    // ignore cookie failures
  }
}

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const cookie of document.cookie.split(";")) {
    const [cookieName, cookieValue] = cookie.trim().split("=");
    if (cookieName === name) return cookieValue ?? null;
  }
  return null;
}
