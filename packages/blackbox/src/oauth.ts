import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import type { ExplorerUrl, FetchLike } from "./types.js";

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

export type PkcePair = {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
};

export function createPkcePair(): PkcePair {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

export function defaultOpenUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const command =
      process.platform === "darwin"
        ? { bin: "open", args: [url] }
        : process.platform === "win32"
          ? { bin: "cmd", args: ["/c", "start", "", url] }
          : { bin: "xdg-open", args: [url] };

    execFile(command.bin, command.args, (err) => {
      resolve(!err);
    });
  });
}

function sendCallbackHtml(res: ServerResponse, status: number, title: string, detail: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px"><h1>${title}</h1><p>${detail}</p></body></html>`,
  );
}

async function readJsonResponse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

export async function authenticateWithExplorer(params: {
  readonly explorerUrl: ExplorerUrl;
  readonly openBrowser: boolean;
  readonly fetch: FetchLike;
  readonly openUrl: (url: string) => Promise<boolean>;
  readonly log: (message: string) => void;
  readonly timeoutMs?: number;
}): Promise<string> {
  const { explorerUrl, openBrowser, fetch, openUrl, log } = params;
  const timeoutMs = params.timeoutMs ?? OAUTH_TIMEOUT_MS;
  const state = randomBytes(16).toString("base64url");
  const { codeVerifier, codeChallenge } = createPkcePair();

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (reqUrl.pathname !== "/callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const oauthError = reqUrl.searchParams.get("error");
    if (oauthError) {
      const desc = reqUrl.searchParams.get("error_description") ?? oauthError;
      sendCallbackHtml(res, 400, "Authorization failed", desc);
      rejectCode(new Error(`OAuth authorization failed: ${desc}`));
      return;
    }

    const returnedState = reqUrl.searchParams.get("state");
    const code = reqUrl.searchParams.get("code");
    if (!code || returnedState !== state) {
      sendCallbackHtml(res, 400, "Invalid callback", "Missing authorization code or state mismatch.");
      rejectCode(new Error("OAuth callback state mismatch or missing code"));
      return;
    }

    sendCallbackHtml(res, 200, "Blackbox CLI authorized", "You can close this tab and return to your terminal.");
    resolveCode(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const timer = setTimeout(() => {
    rejectCode(new Error("Timed out waiting for OAuth browser authorization"));
  }, timeoutMs);

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind local OAuth callback server");
    }
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;

    const regRes = await fetch(`${explorerUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "@softprobe/blackbox",
        redirect_uris: [redirectUri],
      }),
    });
    const regBody = await readJsonResponse(regRes);
    if (!regRes.ok || typeof regBody.client_id !== "string" || !regBody.client_id) {
      const desc = typeof regBody.error_description === "string" ? regBody.error_description : regRes.statusText;
      throw new Error(`OAuth client registration failed (${regRes.status}): ${desc}`);
    }

    const authUrl = new URL(`${explorerUrl}/oauth/authorize`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", regBody.client_id);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("resource", `${explorerUrl}/mcp`);
    authUrl.searchParams.set("scope", "mcp:tools");

    log(`Open this URL to authorize Blackbox CLI:\n  ${authUrl.toString()}`);
    if (openBrowser) {
      await openUrl(authUrl.toString());
    }

    const code = await codePromise;

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: regBody.client_id,
      code_verifier: codeVerifier,
      resource: `${explorerUrl}/mcp`,
    });
    const tokenRes = await fetch(`${explorerUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const tokenJson = await readJsonResponse(tokenRes);
    if (!tokenRes.ok || typeof tokenJson.access_token !== "string" || !tokenJson.access_token) {
      const desc = typeof tokenJson.error_description === "string" ? tokenJson.error_description : tokenRes.statusText;
      throw new Error(`OAuth token exchange failed (${tokenRes.status}): ${desc}`);
    }

    return tokenJson.access_token;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}
