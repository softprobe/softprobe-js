import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectName } from "./types.js";

/**
 * Normalize a raw package or directory name into a clean project name.
 * Strips npm scope prefixes (e.g. "@acme/web-app" -> "web-app").
 */
export function normalizeProjectName(raw: string): ProjectName | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const unscoped = trimmed.startsWith("@") && trimmed.includes("/")
    ? trimmed.slice(trimmed.indexOf("/") + 1).trim()
    : trimmed;
  return unscoped.length > 0 ? (unscoped as ProjectName) : null;
}

/**
 * Infer default project name from `package.json` `name` or fallback to the directory name.
 */
export async function inferProjectName(cwd: string): Promise<ProjectName> {
  const pkgPath = path.join(cwd, "package.json");
  try {
    const raw = await readFile(pkgPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "name" in parsed) {
      const nameValue = (parsed as { name?: unknown }).name;
      if (typeof nameValue === "string") {
        const normalized = normalizeProjectName(nameValue);
        if (normalized) return normalized;
      }
    }
  } catch {
    // Missing or invalid package.json falls back to directory name.
  }

  const dirName = normalizeProjectName(path.basename(path.resolve(cwd)));
  return dirName ?? ("blackbox-app" as ProjectName);
}
