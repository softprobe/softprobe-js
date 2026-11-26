import { z } from "zod";

export const UI_ACTION_SCHEMA_VERSION = "sp-ui-action-1" as const;

export type CapturedInputValue =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "secret"; readonly slot: string }
  | { readonly kind: "redacted"; readonly length: number };

export type SemanticAnchorState = "checked" | "expanded" | "pressed" | "selected";
export type SemanticModifierKey = "Alt" | "Control" | "Meta" | "Shift";

export interface SemanticTarget {
  readonly testId?: string;
  readonly accessibilityId?: string;
  readonly role?: string;
  readonly name?: string;
  readonly label?: string;
  readonly nearbyLabel?: string;
  readonly interactive?: boolean;
  readonly placeholder?: string;
  readonly text?: string;
  readonly inputPurpose?: string;
  readonly cssSelector?: string;
  readonly within?: string;
  readonly position?: { readonly index: number; readonly of: number };
  readonly rect?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly pointOffset?: { readonly fx: number; readonly fy: number };
  readonly framePath?: readonly string[];
  readonly rrwebNodeId?: number;
  readonly states?: readonly SemanticAnchorState[];
  readonly value?: string;
}

export interface CausedHttpTrace {
  readonly traceId: string;
  readonly spanId?: string;
  readonly method: string;
  readonly url: string;
  readonly urlTemplate?: string;
  readonly status?: number;
}

export type SemanticVerb =
  | {
      readonly name: "navigate";
      readonly url: string;
      readonly trigger: "load" | "pushState" | "popstate";
    }
  | {
      readonly name: "click" | "dblclick" | "contextmenu" | "hover";
      readonly target: SemanticTarget;
      readonly modifiers?: readonly SemanticModifierKey[];
      readonly point: { readonly x: number; readonly y: number };
    }
  | {
      readonly name: "fill";
      readonly target: SemanticTarget;
      readonly value: CapturedInputValue;
      readonly replace: boolean;
    }
  | {
      readonly name: "select";
      readonly target: SemanticTarget;
      readonly value: CapturedInputValue;
      readonly optionLabel?: string;
    }
  | {
      readonly name: "check";
      readonly target: SemanticTarget;
      readonly checked: boolean;
    }
  | {
      readonly name: "press";
      readonly target?: SemanticTarget;
      readonly key: string;
      readonly modifiers?: readonly SemanticModifierKey[];
    }
  | {
      readonly name: "upload";
      readonly target: SemanticTarget;
      readonly fileNames: readonly string[];
      readonly mimeTypes: readonly string[];
    }
  | {
      readonly name: "drag";
      readonly source: SemanticTarget;
      readonly destination: SemanticTarget;
    }
  | {
      readonly name: "scroll";
      readonly target?: SemanticTarget;
      readonly direction: "up" | "down" | "left" | "right";
      readonly times: number;
      readonly spansViewport: number;
    }
  | {
      readonly name: "dialog";
      readonly dialogType: "alert" | "confirm" | "prompt" | "beforeunload";
      readonly accepted: boolean;
      readonly promptText?: CapturedInputValue;
    }
  | {
      readonly name: "resize";
      readonly viewport: { readonly width: number; readonly height: number };
    }
  | {
      readonly name: "back";
    }
  | {
      readonly name: "dismissKeyboard";
    }
  | {
      readonly name: "openLink";
      readonly url: string;
    }
  | {
      readonly name: "swipe";
      readonly direction: "up" | "down" | "left" | "right";
      readonly target?: SemanticTarget;
      readonly distanceRatio?: number;
    }
  | {
      readonly name: "longPress";
      readonly target: SemanticTarget;
      readonly point?: { readonly x: number; readonly y: number };
      readonly durationMs?: number;
    };

export interface RecordedSemanticAction {
  readonly schemaVersion: "sp-ui-action-1";
  readonly actionIndex: number;
  readonly timestampMs: number;
  readonly startPath: string;
  readonly endPath: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly verb: SemanticVerb;
  readonly causedTraces: readonly CausedHttpTrace[];
  readonly endAnchors: readonly SemanticTarget[];
  readonly goneAnchors: readonly SemanticTarget[];
  readonly settleMs: number;
  readonly platform?: "web" | "ios" | "android";
  readonly captureSource?: "web_sdk" | "host_agent" | "otel_sdk";
}

const capturedInputValueSchema: z.ZodType<CapturedInputValue> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("literal"), value: z.string() }),
    z.object({ kind: z.literal("secret"), slot: z.string().min(1) }),
    z.object({ kind: z.literal("redacted"), length: z.number().int().nonnegative() }),
  ],
);

const modifierKeySchema = z.enum(["Alt", "Control", "Meta", "Shift"]);
const anchorStateSchema = z.enum(["checked", "expanded", "pressed", "selected"]);

export const semanticTargetSchema: z.ZodType<SemanticTarget> = z.object({
  testId: z.string().optional(),
  accessibilityId: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  label: z.string().optional(),
  nearbyLabel: z.string().optional(),
  interactive: z.boolean().optional(),
  placeholder: z.string().optional(),
  text: z.string().optional(),
  inputPurpose: z.string().optional(),
  cssSelector: z.string().optional(),
  within: z.string().optional(),
  position: z
    .object({
      index: z.number().int().nonnegative(),
      of: z.number().int().positive(),
    })
    .optional(),
  rect: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
  pointOffset: z
    .object({
      fx: z.number(),
      fy: z.number(),
    })
    .optional(),
  framePath: z.array(z.string()).optional(),
  rrwebNodeId: z.number().int().nonnegative().optional(),
  states: z.array(anchorStateSchema).optional(),
  value: z.string().optional(),
});

export const causedHttpTraceSchema: z.ZodType<CausedHttpTrace> = z.object({
  traceId: z.string().min(1),
  spanId: z.string().optional(),
  method: z.string().min(1),
  url: z.string().min(1),
  urlTemplate: z.string().optional(),
  status: z.number().int().optional(),
});

export const semanticVerbSchema: z.ZodType<SemanticVerb> = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("navigate"),
    url: z.string().min(1),
    trigger: z.enum(["load", "pushState", "popstate"]),
  }),
  z.object({
    name: z.literal("click"),
    target: semanticTargetSchema,
    modifiers: z.array(modifierKeySchema).optional(),
    point: z.object({ x: z.number(), y: z.number() }),
  }),
  z.object({
    name: z.literal("dblclick"),
    target: semanticTargetSchema,
    modifiers: z.array(modifierKeySchema).optional(),
    point: z.object({ x: z.number(), y: z.number() }),
  }),
  z.object({
    name: z.literal("contextmenu"),
    target: semanticTargetSchema,
    modifiers: z.array(modifierKeySchema).optional(),
    point: z.object({ x: z.number(), y: z.number() }),
  }),
  z.object({
    name: z.literal("hover"),
    target: semanticTargetSchema,
    modifiers: z.array(modifierKeySchema).optional(),
    point: z.object({ x: z.number(), y: z.number() }),
  }),
  z.object({
    name: z.literal("fill"),
    target: semanticTargetSchema,
    value: capturedInputValueSchema,
    replace: z.boolean(),
  }),
  z.object({
    name: z.literal("select"),
    target: semanticTargetSchema,
    value: capturedInputValueSchema,
    optionLabel: z.string().optional(),
  }),
  z.object({
    name: z.literal("check"),
    target: semanticTargetSchema,
    checked: z.boolean(),
  }),
  z.object({
    name: z.literal("press"),
    target: semanticTargetSchema.optional(),
    key: z.string().min(1),
    modifiers: z.array(modifierKeySchema).optional(),
  }),
  z.object({
    name: z.literal("upload"),
    target: semanticTargetSchema,
    fileNames: z.array(z.string()),
    mimeTypes: z.array(z.string()),
  }),
  z.object({
    name: z.literal("drag"),
    source: semanticTargetSchema,
    destination: semanticTargetSchema,
  }),
  z.object({
    name: z.literal("scroll"),
    target: semanticTargetSchema.optional(),
    direction: z.enum(["up", "down", "left", "right"]),
    times: z.number().int().positive(),
    spansViewport: z.number(),
  }),
  z.object({
    name: z.literal("dialog"),
    dialogType: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
    accepted: z.boolean(),
    promptText: capturedInputValueSchema.optional(),
  }),
  z.object({
    name: z.literal("resize"),
    viewport: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
  }),
  z.object({
    name: z.literal("back"),
  }),
  z.object({
    name: z.literal("dismissKeyboard"),
  }),
  z.object({
    name: z.literal("openLink"),
    url: z.string().min(1),
  }),
  z.object({
    name: z.literal("swipe"),
    direction: z.enum(["up", "down", "left", "right"]),
    target: semanticTargetSchema.optional(),
    distanceRatio: z.number().positive().optional(),
  }),
  z.object({
    name: z.literal("longPress"),
    target: semanticTargetSchema,
    point: z.object({ x: z.number(), y: z.number() }).optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
]);

export const recordedSemanticActionSchema: z.ZodType<RecordedSemanticAction> = z.object({
  schemaVersion: z.literal(UI_ACTION_SCHEMA_VERSION),
  actionIndex: z.number().int().nonnegative(),
  timestampMs: z.number(),
  startPath: z.string(),
  endPath: z.string(),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  verb: semanticVerbSchema,
  causedTraces: z.array(causedHttpTraceSchema),
  endAnchors: z.array(semanticTargetSchema),
  goneAnchors: z.array(semanticTargetSchema),
  settleMs: z.number().nonnegative(),
  platform: z.enum(["web", "ios", "android"]).optional(),
  captureSource: z.enum(["web_sdk", "host_agent", "otel_sdk"]).optional(),
});
