# `@softprobe/react-native`

`@softprobe/react-native` extends official OpenTelemetry JS (`@opentelemetry/api` and `@opentelemetry/sdk-trace-base`) for React Native and Expo apps. It stamps `sp.session.id` onto spans, propagates W3C `traceparent` and `baggage` headers on `fetch`, and records `softprobe.ui.action` (`sp-ui-action-1`) spans with secret redaction.

## Install

```bash
npm install @softprobe/react-native @opentelemetry/api @opentelemetry/sdk-trace-base
```

## Attach to an existing OpenTelemetry `TracerProvider`

If your app already configures `BasicTracerProvider` or `WebTracerProvider`, call `installSoftprobeReactNative` to attach Softprobe onto that provider without adding a second OTLP exporter.

```ts
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { installSoftprobeReactNative } from "@softprobe/react-native";

const tracerProvider = new BasicTracerProvider({
	spanProcessors: [yourExistingSpanProcessor],
});

export const softprobe = installSoftprobeReactNative({
	tracerProvider,
	platform: "android",
	serviceName: "acme-mobile",
	launchArguments: initialProps,
	apiOrigins: ["https://api.acme.com"],
	secretSlots: {
		invite_password: "INVITE_PASSWORD",
	},
});
```

## Initialize with built-in OTLP JSON export

If your app does not configure its own `TracerProvider`, call `initSoftprobeReactNative` to create a `BasicTracerProvider` with a `fetch`-based OTLP JSON exporter (`/v1/traces`).

```ts
import { initSoftprobeReactNative } from "@softprobe/react-native";

export const softprobe = initSoftprobeReactNative({
	endpoint: "https://explorer.softprobe.ai/api/thelake",
	ingestionKey: process.env.EXPO_PUBLIC_SOFTPROBE_KEY,
	platform: "ios",
	serviceName: "acme-mobile",
	launchArguments: initialProps,
	apiOrigins: ["https://api.acme.com"],
});
```

## Record navigation and UI actions

Wire navigation state listeners and touch or text callbacks to `softprobe.actions`:

```ts
softprobe.actions.onNavigationRouteChange("TeamInvite");

softprobe.actions.recordFill(
	{ testId: "email_input", role: "textbox", label: "Teammate email" },
	email,
);

softprobe.actions.recordFill(
	{ testId: "password_input", role: "textbox", label: "Password" },
	password,
	{ secureTextEntry: true },
);

softprobe.actions.recordTap({
	testId: "send_invite_button",
	role: "button",
	name: "Send invite",
});
```

When `secureTextEntry` is `true`, `target.inputPurpose` is `"password"`, or a `secretSlots` entry matches the target, `recordFill` exports `{ kind: "secret", slot }` so raw passwords and one-time codes never leave the device.
