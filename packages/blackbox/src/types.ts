export const DEFAULT_EXPLORER_URL = "https://explorer.softprobe.ai";
export const INGESTION_KEY_ENV_VAR = "SOFTPROBE_INGESTION_KEY";

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

export type CliCommand =
  | { readonly kind: "init"; readonly options: InitOptions }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

export type InitResult = {
  readonly projectName: ProjectName;
  readonly explorerUrl: ExplorerUrl;
  readonly envPath: string;
  readonly ingestionKey: IngestionKey;
  readonly source: "flag" | "oauth";
  readonly envAction: "created" | "updated" | "unchanged";
};

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type InitDeps = {
  readonly fetch: FetchLike;
  readonly openUrl: (url: string) => Promise<boolean>;
  readonly log: (message: string) => void;
};
