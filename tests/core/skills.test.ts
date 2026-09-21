import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillCatalog } from "@/core/skills.ts";

const skillDir = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "jev-skills-"));
  await mkdir(join(root, "debugging"), { recursive: true });
  await writeFile(
    join(root, "debugging", "SKILL.md"),
    "---\nname: debugging\ndescription: >-\n  Root-cause work for failures\n  and unexpected behavior.\n---\n\n# debugging\n",
  );
  await mkdir(join(root, "no-front-matter"), { recursive: true });
  await writeFile(join(root, "no-front-matter", "SKILL.md"), "# just a file\n");
  await mkdir(join(root, "unnamed"), { recursive: true });
  await writeFile(join(root, "unnamed", "SKILL.md"), "---\ndescription: Named by folder.\n---\n");
  return root;
};

describe("readSkillCatalog", () => {
  it("reads front matter from a directory, folding multi-line descriptions", async () => {
    const skills = await Effect.runPromise(readSkillCatalog(await skillDir(), "dir"));

    expect(skills).toEqual([
      { name: "debugging", description: "Root-cause work for failures and unexpected behavior." },
      { name: "unnamed", description: "Named by folder." },
    ]);
  });

  it("reads a JSON catalog file", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "jev-skills-")), "catalog.json");
    await writeFile(
      file,
      JSON.stringify([
        { name: "plan", description: "Plan work." },
        { name: "debugging", description: "Root-cause work." },
      ]),
    );

    const skills = await Effect.runPromise(readSkillCatalog(file, "file"));

    expect(skills.map((skill) => skill.name)).toEqual(["plan", "debugging"]);
  });

  it("treats a missing source as an empty catalog", async () => {
    expect(
      await Effect.runPromise(readSkillCatalog(join(tmpdir(), "jev-none", "nothing"), "file")),
    ).toEqual([]);
    expect(
      await Effect.runPromise(readSkillCatalog(join(tmpdir(), "jev-none", "nothing"), "dir")),
    ).toEqual([]);
  });

  it("skips a catalog file that does not match the shape", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "jev-skills-")), "broken.json");
    await writeFile(file, JSON.stringify([{ name: "no description" }]));

    expect(await Effect.runPromise(readSkillCatalog(file, "file"))).toEqual([]);
  });
});
