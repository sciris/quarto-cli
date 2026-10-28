/*
 * environment.ts
 *
 * Copyright (C) 2024 Posit Software, PBC
 */

import { basename, dirname } from "../deno_ral/path.ts";
import { ExecuteOptions } from "./types.ts";
import { InternalError } from "../core/lib/error.ts";
import { resolve } from "../deno_ral/path.ts";

export const setExecuteEnvironment: (options: ExecuteOptions) => void = (
  options,
) => {
  const env: Record<string, string> = {};
  if (options.projectDir) {
    env.QUARTO_PROJECT_ROOT = options.projectDir;
    env.QUARTO_DOCUMENT_PATH = dirname(options.target.source);
    env.QUARTO_DOCUMENT_FILE = basename(options.target.source);
  } else {
    // FIXME: This should not be passthrough anymore as singleFileProjectContext always set `options.projectDir`
    // https://github.com/quarto-dev/quarto-cli/pull/8771
    if (!options.cwd) {
      throw new InternalError(
        "No project directory or current working directory",
      );
    }
    env.QUARTO_PROJECT_ROOT = options.cwd;
    env.QUARTO_DOCUMENT_PATH = options.cwd;
    env.QUARTO_DOCUMENT_FILE = basename(options.target.source);
  }

  const executeInfo: Record<string, unknown> = {
    "document-path": resolve(options.target.source),
    format: options.format,
  };

  env.QUARTO_EXECUTE_INFO = options.project.temp.createFileFromString(
    JSON.stringify(executeInfo),
  );

  for (const [key, value] of Object.entries(env)) {
    Deno.env.set(key, value);
  }
  options.executeEnv = env;
};
