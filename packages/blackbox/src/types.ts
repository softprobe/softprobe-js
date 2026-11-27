export const DEFAULT_EXPLORER_URL = "https://explorer.softprobe.ai";
export const INGESTION_KEY_ENV_VAR = "INGESTION_KEY";

export type ExplorerUrl = string & { readonly __brand: "ExplorerUrl" };
export type IngestionKey = string & { readonly __brand: "IngestionKey" };
export type ProjectName = string & { readonly __brand: "ProjectName" };

export type InitOptions = {
  readonly cwd: string;
  readonly explorerUrl: ExplorerUrl;
  readonly ingestionKey?: IngestionKey;
  readonly projectName?: ProjectName;
  readonly envFile: string;
  readonly openBrowser: boolean;
};

export type HookAgent = "cursor" | "claude-code" | "auto";

export type HookOptions = {
  readonly agent: HookAgent;
  readonly configPath?: string;
};

export type CliCommand =
  | { readonly kind: "init"; readonly options: InitOptions }
  | { readonly kind: "hook"; readonly options: HookOptions }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

export type BootstrapProjectResult = {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly ingestionKey: IngestionKey;
  readonly otlpEndpoint: string;
};

export type InitResult = {
  readonly projectName: ProjectName;
  readonly explorerUrl: ExplorerUrl;
  readonly envPath: string;
  readonly ingestionKey: IngestionKey;
  readonly source: "flag" | "oauth";
  readonly envAction: "created" | "updated" | "unchanged";
  readonly workspaceId?: string;
  readonly agentId?: string;
  readonly otlpEndpoint?: string;
};

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type InitDeps = {
  readonly fetch: FetchLike;
  readonly openUrl: (url: string) => Promise<boolean>;
  readonly log: (message: string) => void;
};
