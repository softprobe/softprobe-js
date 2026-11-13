import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

describe("agent skill placement", () => {
  it("keeps developer skills in the central workspace", () => {
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url))
    const localSkillDirectories = [".agents/skills", ".cursor/skills", ".agent/skills"]
    const presentDirectories = localSkillDirectories.filter((directory) =>
      existsSync(resolve(repositoryRoot, directory)),
    )

    expect(
      presentDirectories,
      "Developer skills must live in the central mono repo softprobe/dev at .agents/skills/ because agents run from that workspace.",
    ).toEqual([])
  })
})
