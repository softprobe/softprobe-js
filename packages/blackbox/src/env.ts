import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type UpsertEnvResult = {
  readonly content: string;
  readonly action: "created" | "updated" | "unchanged";
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatEnvValue(value: string): string {
  if (/[\s#"'\\]/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Idempotently upsert `KEY=value` in a `.env` file string without clobbering
 * unrelated variables, comments, or ordering.
 */
export function upsertEnvVar(
  existingContent: string | null,
  key: string,
  value: string,
): UpsertEnvResult {
  const formattedLine = `${key}=${formatEnvValue(value)}`;

  if (existingContent === null) {
    return {
      content: `${formattedLine}\n`,
      action: "created",
    };
  }

  const eol = existingContent.includes("\r\n") ? "\r\n" : "\n";
  const lines = existingContent.split(/\r?\n/);
  const matcher = new RegExp(`^(\\s*(?:export\\s+)?)${escapeRegExp(key)}\\s*=`);

  let matchedIndex = -1;
  let exportPrefix = "";
  for (let i = 0; i < lines.length; i++) {
    const match = matcher.exec(lines[i]!);
    if (match) {
      matchedIndex = i;
      exportPrefix = match[1] ?? "";
      break;
    }
  }

  if (matchedIndex !== -1) {
    const nextLine = `${exportPrefix}${formattedLine}`;
    if (lines[matchedIndex] === nextLine) {
      return { content: existingContent, action: "unchanged" };
    }
    const updatedLines = [...lines];
    updatedLines[matchedIndex] = nextLine;
    return {
      content: updatedLines.join(eol),
      action: "updated",
    };
  }

  if (existingContent.length === 0) {
    return {
      content: `${formattedLine}\n`,
      action: "updated",
    };
  }

  const needsLeadingNewline = !existingContent.endsWith("\n") && !existingContent.endsWith("\r\n");
  const separator = needsLeadingNewline ? eol : "";
  return {
    content: `${existingContent}${separator}${formattedLine}${eol}`,
    action: "updated",
  };
}

export async function writeEnvVar(params: {
  readonly envPath: string;
  readonly key: string;
  readonly value: string;
}): Promise<{ readonly envPath: string; readonly action: "created" | "updated" | "unchanged" }> {
  const resolvedPath = path.resolve(params.envPath);
  let existing: string | null = null;
  try {
    existing = await readFile(resolvedPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      throw err;
    }
  }

  const result = upsertEnvVar(existing, params.key, params.value);
  if (result.action !== "unchanged") {
    await writeFile(resolvedPath, result.content, "utf8");
  }
  return {
    envPath: resolvedPath,
    action: result.action,
  };
}
