/*
 * render-incremental.ts
 *
 * Copyright (C) 2026 Posit Software, PBC
 */

// Support for `quarto render --incremental`: a full project render (pre and
// post render scripts run as usual) that only renders the files whose source
// changed since the last render, or whose outputs are missing. Any change to
// the project configuration (or to the render flags) renders everything.
//
// This is a shortcut: changes that only affect other pages (e.g. a page title
// shown in the sidebar of every page), or to files that aren't project
// config or sources (includes, scss, extensions), don't cause re-renders.

import { existsSync } from "../../deno_ral/fs.ts";
import { join, relative } from "../../deno_ral/path.ts";
import { md5HashSync } from "../../core/hash.ts";
import { ProjectContext } from "../../project/types.ts";
import { projectScratchPath } from "../../project/project-scratch.ts";
import { RenderFlags } from "./types.ts";
import { readExecuteFailures } from "./freeze.ts";

const kIncrementalStateFile = "incremental-render.json";

interface IncrementalState {
  config: string;
  files: Record<string, { hash: string; outputs: string[] }>;
}

function readState(context: ProjectContext): IncrementalState | undefined {
  try {
    return JSON.parse(
      Deno.readTextFileSync(
        projectScratchPath(context.dir, kIncrementalStateFile),
      ),
    ) as IncrementalState;
  } catch {
    return undefined;
  }
}

function fileHash(path: string) {
  try {
    return md5HashSync(Deno.readTextFileSync(path));
  } catch {
    return "";
  }
}

// hash of everything that applies to every file: the config files and the
// flags (other than the ones that only affect how the render is carried out,
// some of which project renders set themselves)
function configHash(context: ProjectContext, flags?: RenderFlags) {
  const {
    incremental: _incremental,
    jobs: _jobs,
    keepGoing: _keepGoing,
    quiet: _quiet,
    noScripts: _noScripts,
    retryFailed: _retryFailed,
    executeDaemon: _executeDaemon,
    executeDaemonRestart: _executeDaemonRestart,
    executeDir: _executeDir,
    ...renderFlags
  } = flags || {};
  const parts = [JSON.stringify(renderFlags)];
  for (const file of [...context.files.config || []].sort()) {
    parts.push(file, fileHash(file));
  }
  return md5HashSync(parts.join("\n"));
}

// The files (of `files`) that need rendering, or undefined if they all do
export function changedProjectFiles(
  context: ProjectContext,
  files: string[],
  flags?: RenderFlags,
): string[] | undefined {
  const state = readState(context);
  if (!state || state.config !== configHash(context, flags)) {
    return undefined;
  }
  // files whose execution failed are rendered again if they're to be retried
  const failed = flags?.retryFailed ? readExecuteFailures(context) : {};
  return files.filter((file) => {
    const key = relative(context.dir, file);
    const previous = state.files[key];
    return key in failed || !previous || previous.hash !== fileHash(file) ||
      previous.outputs.length === 0 ||
      previous.outputs.some((output) => !existsSync(join(context.dir, output)));
  });
}

// Note the files rendered (and their outputs) for the next incremental render
export function recordRenderedFiles(
  context: ProjectContext,
  rendered: Array<{ input: string; file: string }>,
  flags: RenderFlags | undefined,
  renderedAll: boolean,
) {
  const config = configHash(context, flags);
  const previous = readState(context);
  const state: IncrementalState = {
    config,
    files: (!renderedAll && previous?.config === config && previous?.files) ||
      {},
  };
  const outputs: Record<string, string[]> = {};
  for (const { input, file } of rendered) {
    const key = relative(context.dir, input);
    outputs[key] = outputs[key] || [];
    outputs[key].push(relative(context.dir, file));
  }
  for (const [key, files] of Object.entries(outputs)) {
    state.files[key] = {
      hash: fileHash(join(context.dir, key)),
      outputs: files,
    };
  }
  Deno.writeTextFileSync(
    projectScratchPath(context.dir, kIncrementalStateFile),
    JSON.stringify(state),
  );
}
