/*
 * cmd.ts
 *
 * Copyright (C) 2026 Posit Software, PBC
 */

import { Command } from "cliffy/command/mod.ts";

import { existsSync, safeRemoveDirSync, safeRemoveSync } from "../../deno_ral/fs.ts";
import { basename, dirname, join, relative } from "../../deno_ral/path.ts";
import { info, warning } from "../../deno_ral/log.ts";
import { normalizePath } from "../../core/path.ts";
import { inputFilesDir } from "../../core/render.ts";
import { projectContext } from "../../project/project-context.ts";
import { projectOutputDir } from "../../project/project-shared.ts";
import { kProjectLibDir } from "../../project/types.ts";
import { notebookContext } from "../../render/notebook/notebook-context.ts";
import {
  initState,
  setInitializer,
} from "../../core/lib/yaml-validation/state.ts";
import { initYamlIntelligenceResourcesFromFilesystem } from "../../core/schema/utils.ts";

// what a render leaves in an input's <stem>_files dir before it is moved to the
// output dir (so a dir holding anything else isn't treated as debris)
const kRenderFilesEntries = [
  "execute-results",
  "figure-html",
  "figure-commonmark",
  "figure-gfm",
  "figure-ipynb",
  "figure-latex",
  "figure-docx",
  "figure-pptx",
  "figure-revealjs",
  "figure-typst",
  "libs",
  "mediabag",
];

export const cleanCommand = new Command()
  .name("clean")
  .arguments("[dir]")
  .option(
    "--dry-run",
    "List what would be removed without removing it.",
  )
  .description(
    "Remove the intermediate files that interrupted renders leave in a project.\n\n" +
      "For a project with an output-dir, this removes the <name>_files folders next to " +
      "its source files, transient .quarto_ipynb notebooks, and a stray lib dir " +
      "(e.g. site_libs) in the project folder. Anything tracked by git, and any " +
      "<name>_files folder holding things a render doesn't create, is left alone. " +
      "Outputs, the freezer and caches are not touched.",
  )
  .example("Clean the project in the current directory", "quarto clean")
  .example("See what would be removed", "quarto clean --dry-run")
  // deno-lint-ignore no-explicit-any
  .action(async (options: any, dir?: string) => {
    // one-time initialization of yaml validation modules (to read the project config)
    setInitializer(initYamlIntelligenceResourcesFromFilesystem);
    await initState();

    dir = normalizePath(dir || Deno.cwd());
    const context = await projectContext(dir, notebookContext());
    if (!context?.config) {
      throw new Error(`${dir} is not in a Quarto project.`);
    }
    const projDir = normalizePath(context.dir);
    const outputDir = normalizePath(projectOutputDir(context));
    const dryRun = !!options.dryRun;

    // a project without an output-dir keeps <name>_files next to its outputs
    const hasOutputDir = outputDir !== projDir;
    if (!hasOutputDir) {
      info(
        "The project has no output-dir, so <name>_files folders are outputs: only removing transient notebooks.",
      );
    }

    // candidates (dirs and files)
    const candidates: string[] = [];
    const skipped: string[] = [];
    for (const input of context.files.input) {
      const inputDir = dirname(input);
      if (hasOutputDir) {
        const filesDir = join(inputDir, inputFilesDir(input));
        if (existsSync(filesDir)) {
          const unexpected = [...Deno.readDirSync(filesDir)].filter((entry) =>
            !kRenderFilesEntries.includes(entry.name)
          );
          if (unexpected.length) {
            skipped.push(filesDir);
          } else {
            candidates.push(filesDir);
          }
        }
      }
      const stem = basename(inputFilesDir(input), "_files");
      for (const entry of Deno.readDirSync(inputDir)) {
        if (
          entry.isFile &&
          (entry.name === `${stem}.quarto_ipynb` ||
            entry.name.startsWith(`${stem}.quarto_ipynb_`))
        ) {
          candidates.push(join(inputDir, entry.name));
        }
      }
    }
    const libDir = context.config.project[kProjectLibDir];
    if (hasOutputDir && libDir && existsSync(join(projDir, libDir))) {
      candidates.push(join(projDir, libDir));
    }

    // leave anything git tracks
    const tracked = gitTrackedPaths(projDir, candidates);
    const toRemove = candidates.filter((path) => !tracked.has(path));
    skipped.push(...candidates.filter((path) => tracked.has(path)));

    for (const path of skipped) {
      warning(
        `Leaving ${relative(projDir, path)} (tracked by git, or holds files a render doesn't create)`,
      );
    }
    if (toRemove.length === 0) {
      info("Nothing to clean.");
      return;
    }
    for (const path of toRemove) {
      info(`${dryRun ? "Would remove" : "Removing"} ${relative(projDir, path)}`);
      if (!dryRun) {
        if (Deno.statSync(path).isDirectory) {
          safeRemoveDirSync(path, projDir);
        } else {
          safeRemoveSync(path);
        }
      }
    }
    info(
      `${dryRun ? "Would remove" : "Removed"} ${toRemove.length} item(s).`,
    );
  });

// the paths (of `paths`) that are, or contain, files tracked by git
function gitTrackedPaths(dir: string, paths: string[]) {
  const tracked = new Set<string>();
  if (paths.length === 0) {
    return tracked;
  }
  try {
    const result = new Deno.Command("git", {
      args: ["ls-files", "-z", "--", ...paths.map((p) => relative(dir, p))],
      cwd: dir,
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (!result.success) {
      return tracked;
    }
    const files = new TextDecoder().decode(result.stdout).split("\0")
      .filter((f) => f.length > 0)
      .map((f) => join(dir, f));
    for (const path of paths) {
      if (files.some((f) => f === path || f.startsWith(path + "/"))) {
        tracked.add(path);
      }
    }
  } catch {
    // not a git repo (or no git): rely on the contents check
  }
  return tracked;
}
