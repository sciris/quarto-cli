/*
 * render-files.ts
 *
 * Copyright (C) 2020-2022 Posit Software, PBC
 */

// ensures cell handlers are installed
import "../../core/handlers/handlers.ts";

import {
  kExecuteEnabled,
  kFreeze,
  kIncludeInHeader,
  kKeepMd,
  kLang,
  kQuartoRequired,
} from "../../config/constants.ts";
import { isHtmlCompatible } from "../../config/format.ts";
import { mergeConfigs } from "../../core/config.ts";
import { initDayJsPlugins, setDateLocale } from "../../core/date.ts";
import { initDenoDom } from "../../core/deno-dom.ts";
import { HandlerContextResults } from "../../core/handlers/types.ts";
import {
  handleLanguageCells,
  languages,
  resetFigureCounter,
} from "../../core/handlers/base.ts";
import { LanguageCellHandlerOptions } from "../../core/handlers/types.ts";
import { asMappedString, mappedDiff } from "../../core/mapped-text.ts";
import {
  validateDocument,
  validateDocumentFromSource,
} from "../../core/schema/validate-document.ts";
import { createTempContext, TempContext } from "../../core/temp.ts";
import {
  executionEngineKeepMd,
  fileExecutionEngineAndTarget,
} from "../../execute/engine.ts";
import { annotateOjsLineNumbers } from "../../execute/ojs/annotate-source.ts";
import { ojsExecuteResult } from "../../execute/ojs/compile.ts";
import {
  ExecuteOptions,
  ExecuteResult,
  MappedExecuteResult,
} from "../../execute/types.ts";
import { kProjectLibDir, ProjectContext } from "../../project/types.ts";
import { outputRecipe } from "./output.ts";

import { renderPandoc } from "./render.ts";
import { PandocRenderCompletion, RenderServices } from "./types.ts";
import { renderContexts } from "./render-contexts.ts";
import { existsSync, safeRemoveDirSync } from "../../deno_ral/fs.ts";
import { clearInputTargetIndexMemo } from "../../project/project-index.ts";
import { renderProgress } from "./render-info.ts";
import {
  ExecutedFile,
  PandocRenderer,
  RenderContext,
  RenderedFile,
  RenderedFormat,
  RenderExecuteOptions,
  RenderFile,
  RenderFilesResult,
  RenderFlags,
  RenderOptions,
} from "./types.ts";
import { error, info, warning } from "../../deno_ral/log.ts";
import * as ld from "../../core/lodash.ts";
import { basename, dirname, join, relative } from "../../deno_ral/path.ts";
import { Format } from "../../config/types.ts";
import {
  figuresDir,
  inputFilesDir,
  isServerShiny,
  isServerShinyKnitr,
  keepMdCollidesWithFormatOutput,
  projectedOutputFile,
} from "../../core/render.ts";
import {
  normalizePath,
  removeIfEmptyDir,
  removeIfExists,
} from "../../core/path.ts";
import { resourcePath } from "../../core/resources.ts";
import { YAMLValidationError } from "../../core/yaml.ts";
import { resolveParams } from "./flags.ts";
import {
  copyFromProjectFreezer,
  copyToProjectFreezer,
  defrostExecuteResult,
  frozenResultIsCurrent,
  readExecuteFailures,
  sourceFreezeHash,
  writeExecuteFailures,
  freezeExecuteResult,
  freezerFigsDir,
  freezerFreezeFile,
  kProjectFreezeDir,
  removeFreezeResults,
} from "./freeze.ts";
import { isJupyterNotebook } from "../../core/jupyter/jupyter.ts";
import { MappedString } from "../../core/lib/text-types.ts";
import {
  createNamedLifetime,
  Lifetime,
  waitUntilNamedLifetime,
} from "../../core/lifetimes.ts";
import { resolveDependencies } from "./pandoc-dependencies-html.ts";
import {
  getData as getTimingData,
  pop as popTiming,
  push as pushTiming,
  withTiming,
  withTimingAsync,
} from "../../core/timing.ts";
import { satisfies } from "semver/mod.ts";
import { quartoConfig } from "../../core/quarto.ts";
import { ensureNotebookContext } from "../../core/jupyter/jupyter-embed.ts";
import {
  clearInputRelativePathsCache,
  projectIsWebsite,
  projectOutputDir,
} from "../../project/project-shared.ts";
import { NotebookContext } from "../../render/notebook/notebook-types.ts";
import { setExecuteEnvironment } from "../../execute/environment.ts";
import { safeCloneDeep } from "../../core/safe-clone-deep.ts";
import { warn } from "log";

export async function renderExecute(
  context: RenderContext,
  output: string,
  options: RenderExecuteOptions,
): Promise<ExecuteResult> {
  // are we running a compatible quarto version for this file?
  const versionConstraint = context
    .format.metadata[kQuartoRequired] as (string | undefined);
  if (versionConstraint) {
    const ourVersion = quartoConfig.version();
    let result: boolean;
    try {
      result = satisfies(ourVersion, versionConstraint);
    } catch (_e) {
      throw new Error(
        `In file ${context.target.source}:\nVersion constraint is invalid: ${versionConstraint}.`,
      );
    }
    if (!result) {
      throw new Error(
        `in file ${context.target.source}:\nQuarto version ${ourVersion} does not satisfy version constraint ${versionConstraint}.`,
      );
    }
  }

  // alias options
  const {
    resolveDependencies = true,
    alwaysExecute = false,
    skipExecute = false,
  } = options;

  // alias flags
  const flags = context.options.flags || {};

  // compute filesDir
  const filesDir = inputFilesDir(context.target.source);

  // compute project relative files dir (if we are in a project)
  let projRelativeFilesDir: string | undefined;
  if (context.project) {
    const inputDir = relative(
      context.project.dir,
      dirname(context.target.source),
    );
    projRelativeFilesDir = join(inputDir, filesDir);
  }

  // are we eligible to freeze?
  let canFreeze = context.engine.canFreeze &&
    (context.format.execute[kExecuteEnabled] !== false);

  // use previous frozen results if they are available
  if (
    context.project && !context.project.isSingleFile &&
    (!alwaysExecute || skipExecute)
  ) {
    // check if we are using the freezer (skipExecute takes whatever
    // frozen results there are, even if they are out of date)
    const thaw = canFreeze &&
      (skipExecute || context.format.execute[kFreeze] ||
        (context.options.useFreezer ? "auto" : false));

    if (thaw) {
      // copy from project freezer
      const hidden = context.format.execute[kFreeze] === false;
      copyFromProjectFreezer(
        context.project,
        projRelativeFilesDir!,
        hidden,
      );

      const thawedResult = defrostExecuteResult(
        context.target.source,
        output,
        context.options.services.temp,
        thaw === true,
      );
      if (thawedResult) {
        // copy the site_libs dir from the freezer
        const libDir = context.project?.config?.project[kProjectLibDir];
        if (libDir) {
          copyFromProjectFreezer(context.project, libDir, hidden);
        }

        // remove the results dir
        removeFreezeResults(join(context.project.dir, projRelativeFilesDir!));

        // notify engine that we skipped execute
        if (context.engine.executeTargetSkipped) {
          context.engine.executeTargetSkipped(
            context.target,
            context.format,
          );
        }

        // return results
        return thawedResult;
      }
    }
  }

  // no frozen results to fall back on, so render without executing (and don't
  // let the output-less result replace anything in the freezer)
  if (skipExecute) {
    context.format.execute[kExecuteEnabled] = false;
    canFreeze = false;
  }

  // calculate figsDir
  const figsDir = join(filesDir, figuresDir(context.format.pandoc.to));

  pushTiming("render-execute");

  const executeOptions: ExecuteOptions = {
    target: context.target,
    resourceDir: resourcePath(),
    tempDir: context.options.services.temp.createDir(),
    dependencies: resolveDependencies,
    libDir: context.libDir,
    format: context.format,
    projectDir: context.project?.dir,
    cwd: flags.executeDir || dirname(normalizePath(context.target.source)),
    params: resolveParams(flags.params, flags.paramsFile),
    quiet: flags.quiet,
    previewServer: context.options.previewServer,
    handledLanguages: languages(),
    project: context.project,
  };
  // execute computations
  setExecuteEnvironment(executeOptions);
  let executeResult: ExecuteResult;
  try {
    executeResult = await context.engine.execute(executeOptions);
  } finally {
    popTiming();
  }

  // write the freeze file if we are in a project
  if (context.project && !context.project.isSingleFile && canFreeze) {
    // write the freezer file
    const freezeFile = freezeExecuteResult(
      context.target.source,
      output,
      executeResult,
    );

    // always copy to the hidden freezer
    copyToProjectFreezer(context.project, projRelativeFilesDir!, true, true);

    // copy to the _freeze dir if explicit _freeze is requested
    if (context.format.execute[kFreeze] !== false) {
      copyToProjectFreezer(context.project, projRelativeFilesDir!, false, true);
    } else {
      // otherwise cleanup the _freeze subdir b/c we aren't explicitly freezing anymore

      // figs dir for this target format
      const freezeFigsDir = freezerFigsDir(
        context.project,
        projRelativeFilesDir!,
        basename(figsDir),
      );
      removeIfExists(freezeFigsDir);

      // freezer file
      const projRelativeFreezeFile = relative(context.project.dir, freezeFile);
      const freezerFile = freezerFreezeFile(
        context.project,
        projRelativeFreezeFile,
      );
      removeIfExists(freezerFile);

      // remove empty directories
      removeIfEmptyDir(dirname(freezerFile));
      removeIfEmptyDir(dirname(freezeFigsDir));
      removeIfEmptyDir(join(context.project.dir, kProjectFreezeDir));
    }

    // remove the freeze results file (now that it's safely in the freezer)
    removeFreezeResults(join(context.project.dir, projRelativeFilesDir!));
  }

  // return result
  return executeResult;
}

export async function renderFiles(
  files: RenderFile[],
  options: RenderOptions,
  notebookContext: NotebookContext,
  alwaysExecuteFiles: string[] | undefined,
  pandocRenderer: PandocRenderer | undefined,
  project: ProjectContext,
): Promise<RenderFilesResult> {
  // project types with their own renderer (e.g. books) render serially
  const customRenderer = !!pandocRenderer;

  clearInputRelativePathsCache();
  clearInputTargetIndexMemo();

  // provide default renderer
  pandocRenderer = pandocRenderer || defaultPandocRenderer(options, project);

  // create temp context
  const tempContext = createTempContext();

  try {
    // make a copy of options so we don't mutate caller context
    options = ld.cloneDeep(options);

    // see if we should be using file-by-file progress
    const progress = options.progress ||
      (project && (files.length > 1) && !options.flags?.quiet);

    // quiet pandoc output if we are doing file by file progress
    const pandocQuiet = !!progress || !!options.quietPandoc;

    // calculate num width
    const numWidth = String(files.length).length;

    // with --keep-going, a file that fails is reported and skipped (and
    // rendered again without execution) rather than ending the render
    const keepGoing = !!options.flags?.keepGoing;
    const failures: RenderFileFailure[] = [];

    // with --jobs, execute the files that need it in parallel first: the
    // results go to the freezer, so the render loop below just thaws them
    const jobs = options.flags?.jobs || 1;
    if (jobs > 1 && files.length > 1 && !project.isSingleFile) {
      failures.push(
        ...await executeFilesInParallel(
          files,
          options,
          project,
          notebookContext,
          alwaysExecuteFiles,
          jobs,
          keepGoing,
        ),
      );
    }
    const skipExecuteFiles = new Set(failures.map((f) => f.file));

    // with --jobs, render the files themselves (pandoc and postprocessing)
    // concurrently too
    if (jobs > 1 && files.length > 1 && !customRenderer) {
      return await renderFilesConcurrently(
        files,
        options,
        notebookContext,
        alwaysExecuteFiles,
        project,
        tempContext,
        pandocQuiet,
        jobs,
        keepGoing,
        failures,
        skipExecuteFiles,
      );
    }

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      if (progress) {
        renderProgress(
          `\r[${String(i + 1).padStart(numWidth)}/${files.length}] ${
            relative(project!.dir, file.path)
          }`,
        );
      }

      // get contexts
      const fileLifetime = await waitUntilNamedLifetime("render-file");
      try {
        await renderFileInternal(
          fileLifetime,
          file,
          options,
          project,
          pandocRenderer,
          files,
          tempContext,
          alwaysExecuteFiles,
          pandocQuiet,
          notebookContext,
          true,
          skipExecuteFiles.has(file.path),
        );
      } catch (e) {
        if (!keepGoing) {
          throw e;
        }
        reportRenderFailure(project, file.path, e);
        if (!skipExecuteFiles.has(file.path)) {
          failures.push({ file: file.path, error: e });
        }
      } finally {
        fileLifetime.cleanup();
      }
    }

    if (progress) {
      info("");
    }

    reportRenderFailures(project, failures);

    return await pandocRenderer.onComplete(false, options.flags?.quiet);
  } catch (error) {
    if (!(error instanceof Error)) {
      warn(`Error encountered when rendering files`);
    }
    return {
      files: (await pandocRenderer.onComplete(true)).files,
      error: error instanceof Error
        ? error
        : new Error(error ? String(error) : undefined),
    };
  } finally {
    tempContext.cleanup();
    if (Deno.env.get("QUARTO_PROFILER_OUTPUT")) {
      Deno.writeTextFileSync(
        Deno.env.get("QUARTO_PROFILER_OUTPUT")!,
        JSON.stringify(getTimingData()),
      );
    }
  }
}

interface RenderFileFailure {
  file: string;
  error: unknown;
}

function reportRenderFailures(
  project: ProjectContext,
  failures: RenderFileFailure[],
) {
  if (failures.length) {
    warning(
      `${failures.length} file(s) failed (rendered without fresh outputs where possible):\n` +
        failures.map((f) => `  ${relative(project.dir, f.file)}`).join("\n"),
    );
  }
}

// Render files up to `jobs` at a time, each with its own (default) pandoc
// renderer and lifetime. The first file renders on its own so that shared
// work (e.g. compiling the theme's sass) is cached before the rest start.
async function renderFilesConcurrently(
  files: RenderFile[],
  options: RenderOptions,
  notebookContext: NotebookContext,
  alwaysExecuteFiles: string[] | undefined,
  project: ProjectContext,
  tempContext: TempContext,
  pandocQuiet: boolean,
  jobs: number,
  keepGoing: boolean,
  failures: RenderFileFailure[],
  skipExecuteFiles: Set<string>,
): Promise<RenderFilesResult> {
  const results: RenderedFile[][] = files.map(() => []);
  const numWidth = String(files.length).length;
  let firstError: Error | undefined;
  let done = 0;

  const renderOne = async (i: number) => {
    const file = files[i];
    const renderer = defaultPandocRenderer(options, project);
    const lifetime = new Lifetime();
    try {
      await renderFileInternal(
        lifetime,
        file,
        options,
        project,
        renderer,
        files,
        tempContext,
        alwaysExecuteFiles,
        pandocQuiet,
        notebookContext,
        true,
        skipExecuteFiles.has(file.path),
      );
      results[i] = (await renderer.onComplete(false, options.flags?.quiet))
        .files;
    } catch (e) {
      results[i] = (await renderer.onComplete(true)).files;
      if (!keepGoing) {
        firstError = firstError ||
          (e instanceof Error ? e : new Error(e ? String(e) : undefined));
      } else {
        reportRenderFailure(project, file.path, e);
        if (!skipExecuteFiles.has(file.path)) {
          failures.push({ file: file.path, error: e });
        }
      }
    } finally {
      await lifetime.cleanup();
    }
    done++;
    if (!options.flags?.quiet) {
      info(
        `[${String(done).padStart(numWidth)}/${files.length}] ${
          relative(project.dir, file.path)
        }`,
      );
    }
  };

  await renderOne(0);
  let next = 1;
  const worker = async () => {
    while (next < files.length && !firstError) {
      await renderOne(next++);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(jobs, files.length - 1) }, worker),
  );

  reportRenderFailures(project, failures);
  return { files: results.flat(), error: firstError };
}

function reportRenderFailure(
  project: ProjectContext,
  file: string,
  e: unknown,
) {
  const msg = e instanceof Error ? (e.message || e.name) : String(e ?? "");
  error(
    `Failed to render ${relative(project.dir, file)}${
      msg ? ": " + msg : ""
    } (continuing)`,
  );
}

// Execute (and freeze) every file that needs execution, up to `jobs` at a
// time. Returns the files that failed; with keepGoing the rest still run,
// otherwise the first failure is thrown once the running jobs finish.
async function executeFilesInParallel(
  files: RenderFile[],
  options: RenderOptions,
  project: ProjectContext,
  notebookContext: NotebookContext,
  alwaysExecuteFiles: string[] | undefined,
  jobs: number,
  keepGoing: boolean,
): Promise<RenderFileFailure[]> {
  // per-cell progress from concurrent kernels would just interleave
  const execOptions: RenderOptions = {
    ...options,
    flags: { ...options.flags, quiet: true },
  };

  // with keepGoing, files that failed before and haven't changed since are
  // skipped like frozen ones (rather than failing again on every render)
  const knownFailures = keepGoing ? readExecuteFailures(project) : {};
  const failures: RenderFileFailure[] = [];
  const skippedFailures: string[] = [];

  // only files whose results will be thawed by the render loop are worth
  // executing here (and only the ones whose frozen results are out of date)
  const pending: { file: RenderFile; contexts: RenderContext[] }[] = [];
  for (const file of files) {
    const contexts = Object.values(
      await renderContexts(file, execOptions, true, notebookContext, project),
    ).filter((context) => {
      const execute = context.format.execute;
      if (
        !context.active || !context.engine.canFreeze ||
        execute[kExecuteEnabled] === false ||
        !(execute[kFreeze] || options.useFreezer)
      ) {
        return false;
      }
      if (alwaysExecuteFiles?.includes(file.path)) {
        return true;
      }
      // freeze: auto re-executes when the source changed (freeze: true never)
      return execute[kFreeze] === "auto" &&
        !frozenResultIsCurrent(
          project,
          context.target.source,
          outputRecipe(context).output,
          false,
        );
    });
    if (contexts.length) {
      const relativePath = relative(project.dir, file.path);
      if (
        !alwaysExecuteFiles?.includes(file.path) &&
        !options.flags?.retryFailed &&
        knownFailures[relativePath] === sourceFreezeHash(file.path)
      ) {
        skippedFailures.push(relativePath);
        failures.push({
          file: file.path,
          error: new Error("execution failed in a previous render"),
        });
      } else {
        pending.push({ file, contexts });
      }
    }
  }
  if (skippedFailures.length) {
    warning(
      `Not executing ${skippedFailures.length} unchanged file(s) that failed in a previous render ` +
        `(use --retry-failed, edit them, or render them individually, to retry):\n` +
        skippedFailures.map((f) => `  ${f}`).join("\n"),
    );
  }
  if (pending.length === 0) {
    return failures;
  }

  info(`Executing ${pending.length} file(s) with up to ${jobs} jobs...`);
  const numWidth = String(pending.length).length;
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < pending.length && (keepGoing || failures.length === 0)) {
      const { file, contexts } = pending[next++];
      const start = Date.now();
      let failed = false;
      // a failed execution leaves partial figures behind in <stem>_files
      const filesDir = join(dirname(file.path), inputFilesDir(file.path));
      const hadFilesDir = existsSync(filesDir);
      try {
        for (const context of contexts) {
          const recipe = outputRecipe(context);
          await renderExecute(context, recipe.output, {
            alwaysExecute: alwaysExecuteFiles?.includes(file.path),
          });
        }
      } catch (e) {
        failed = true;
        failures.push({ file: file.path, error: e });
        if (!hadFilesDir && existsSync(filesDir)) {
          safeRemoveDirSync(filesDir, project.dir);
        }
      }
      done++;
      const secs = ((Date.now() - start) / 1000).toFixed(1);
      const line = `[${String(done).padStart(numWidth)}/${pending.length}] ${
        relative(project.dir, file.path)
      } (${secs}s)`;
      if (failed) {
        error(`${line} FAILED`);
      } else {
        info(line);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(jobs, pending.length) }, worker),
  );

  if (!keepGoing && failures.length) {
    throw failures[0].error;
  }

  // remember the failures (and forget files that failed before but now ran)
  if (keepGoing) {
    for (const { file } of pending) {
      delete knownFailures[relative(project.dir, file.path)];
    }
    for (const { file } of failures) {
      knownFailures[relative(project.dir, file)] = sourceFreezeHash(file);
    }
    writeExecuteFailures(project, knownFailures);
  }
  return failures;
}

export async function renderFile(
  file: RenderFile,
  options: RenderOptions,
  services: RenderServices,
  project: ProjectContext,
  enforceProjectFormats: boolean = true,
): Promise<RenderFilesResult> {
  // provide default renderer
  const pandocRenderer = defaultPandocRenderer(options, project);

  try {
    // make a copy of options so we don't mutate caller context
    options = ld.cloneDeep(options);

    // quiet pandoc output if we are doing file by file progress
    const pandocQuiet = !!options.quietPandoc;

    // get contexts
    const fileLifetime = createNamedLifetime("render-single-file");
    try {
      await renderFileInternal(
        fileLifetime,
        file,
        options,
        project,
        pandocRenderer,
        [file],
        services.temp,
        [],
        pandocQuiet,
        services.notebook,
        enforceProjectFormats,
      );
    } finally {
      fileLifetime.cleanup();
    }
    return await pandocRenderer.onComplete(false, options.flags?.quiet);
  } catch (error) {
    if (!(error instanceof Error)) {
      warn(`Error encountered when rendering ${file.path}`);
    }
    return {
      files: (await pandocRenderer.onComplete(true)).files,
      error: error instanceof Error
        ? error
        : new Error(error ? String(error) : undefined),
    };
  } finally {
    if (Deno.env.get("QUARTO_PROFILER_OUTPUT")) {
      Deno.writeTextFileSync(
        Deno.env.get("QUARTO_PROFILER_OUTPUT")!,
        JSON.stringify(getTimingData()),
      );
    }
  }
}

async function renderFileInternal(
  lifetime: Lifetime,
  file: RenderFile,
  options: RenderOptions,
  project: ProjectContext,
  pandocRenderer: PandocRenderer,
  files: RenderFile[],
  tempContext: TempContext,
  alwaysExecuteFiles: string[] | undefined,
  pandocQuiet: boolean,
  notebookContext: NotebookContext,
  enforceProjectFormats: boolean = true,
  skipExecute: boolean = false,
) {
  const outputs: Array<RenderedFormat> = [];
  let contexts: Record<string, RenderContext> | undefined;
  try {
    contexts = await renderContexts(
      file,
      options,
      true,
      notebookContext,
      project,
      false,
      enforceProjectFormats,
    );

    // Allow renderers to filter the contexts
    contexts = pandocRenderer.onFilterContexts(
      file.path,
      contexts,
      files,
      options,
    );

    // let each context know the projected outputs of every declared format,
    // including formats not in this render (e.g. quarto render --to html):
    // keep-md intermediate handling must not write to or delete a path that
    // a format owns (e.g. output-file: index.html plus a markdown format
    // yields index.html.md, which is also the conventional keep-md location
    // for the html format) (#14669)
    const formatOutputs = Object.values(contexts)
      .map((context) =>
        projectedOutputFile(context.target.input, context.format)
      );
    for (const context of Object.values(contexts)) {
      context.siblingFormatOutputs = formatOutputs;
    }
  } catch (e) {
    // bad YAML can cause failure before validation. We
    // reconstruct the context as best we can and try to validate.
    // note that this ignores "validate-yaml: false"
    const { engine, target } = await fileExecutionEngineAndTarget(
      file.path,
      options.flags,
      project,
    );
    const validationResult = await validateDocumentFromSource(
      target.markdown,
      engine.name,
      error,
    );
    if (validationResult.length) {
      throw new RenderInvalidYAMLError();
    } else {
      // rethrow if no validation error happened.
      throw e;
    }
  }
  const mergeHandlerResults = (
    results: HandlerContextResults | undefined,
    executeResult: MappedExecuteResult,
    context: RenderContext,
  ) => {
    if (results === undefined) {
      return;
    }
    if (executeResult.includes) {
      executeResult.includes = mergeConfigs(
        executeResult.includes,
        results.includes,
      );
    } else {
      executeResult.includes = results.includes;
    }
    const extras = resolveDependencies(
      results.extras,
      dirname(context.target.source),
      context.libDir,
      tempContext,
      project,
    );
    if (extras[kIncludeInHeader]) {
      // note that we merge engine execute results back into cell handler
      // execute results so that jupyter widget dependencies appear at the
      // end (so that they don't mess w/ other libs using require/define)
      executeResult.includes[kIncludeInHeader] = [
        ...(extras[kIncludeInHeader] || []),
        ...(executeResult.includes[kIncludeInHeader] || []),
      ];
    }
    executeResult.supporting.push(...results.supporting);
  };

  for (const format of Object.keys(contexts)) {
    pushTiming("render-context");
    const context = safeCloneDeep(contexts[format]); // since we're going to mutate it...

    // disquality some documents from server: shiny
    if (isServerShiny(context.format) && context.project) {
      const src = relative(context.project?.dir!, context.target.source);
      if (projectIsWebsite(context.project)) {
        error(
          `${src} uses server: shiny so cannot be included in a website project ` +
            `(shiny documents require a backend server and so can't be published as static web content).`,
        );
        throw new Error();
      } else if (
        (projectOutputDir(context.project) !==
          normalizePath(context.project.dir)) &&
        isServerShinyKnitr(context.format, context.engine.name)
      ) {
        error(
          `${src} is a knitr engine document that uses server: shiny so cannot be included in a project with an output-dir ` +
            `(shiny document output must be rendered alongside its source document).`,
        );
        throw new Error();
      }
    }

    // get output recipe
    const recipe = outputRecipe(context);
    outputs.push({
      path: recipe.finalOutput || recipe.output,
      isTransient: recipe.isOutputTransient,
      format: context.format,
    });

    if (context.active) {
      // Set the date locale for this render
      // Used for date formatting
      initDayJsPlugins();
      const resolveLang = () => {
        const lang = context.format.metadata[kLang] ||
          options.flags?.pandocMetadata?.[kLang];
        if (typeof lang === "string") {
          return lang;
        } else {
          return undefined;
        }
      };
      const dateFormatLang = resolveLang();
      if (dateFormatLang) {
        await setDateLocale(
          dateFormatLang,
        );
      }

      lifetime.attach({
        cleanup() {
          resetFigureCounter();
        },
      });
      try {
        // one time denoDom init for html compatible formats
        if (isHtmlCompatible(context.format)) {
          await initDenoDom();
        }

        // determine execute options
        const executeOptions = mergeConfigs(
          {
            alwaysExecute: alwaysExecuteFiles?.includes(file.path),
            skipExecute,
          },
          pandocRenderer.onBeforeExecute(recipe.format),
        );

        const validate = context.format.render?.["validate-yaml"];
        if (validate !== false) {
          const validationResult = await validateDocument(context);
          if (validationResult.length) {
            throw new RenderInvalidYAMLError();
          }
        }

        // FIXME it should be possible to infer this directly now
        // based on the information in the mapped strings.
        //
        // collect line numbers to facilitate runtime error reporting
        const { ojsBlockLineNumbers } = annotateOjsLineNumbers(context);

        // execute
        const baseExecuteResult = await renderExecute(
          context,
          recipe.output,
          executeOptions,
        );

        // recover source map from diff and create a mappedExecuteResult
        // for markdown processing pre-pandoc with mapped strings
        let mappedMarkdown: MappedString;

        withTiming("diff-execute-result", () => {
          if (!isJupyterNotebook(context.target.source)) {
            mappedMarkdown = mappedDiff(
              context.target.markdown,
              baseExecuteResult.markdown,
            );
          } else {
            mappedMarkdown = asMappedString(baseExecuteResult.markdown);
          }
        });

        const resourceFiles: string[] = [];
        if (baseExecuteResult.resourceFiles) {
          resourceFiles.push(...baseExecuteResult.resourceFiles);
        }

        const languageCellHandlerOptions: LanguageCellHandlerOptions = {
          name: "",
          temp: tempContext,
          format: recipe.format,
          markdown: mappedMarkdown!,
          context,
          flags: options.flags || {} as RenderFlags,
          stage: "post-engine",
        };

        let unmappedExecuteResult: ExecuteResult;
        await withTimingAsync("handle-language-cells", async () => {
          // handle language cells
          const { markdown, results } = await handleLanguageCells(
            languageCellHandlerOptions,
          );
          const mappedExecuteResult: MappedExecuteResult = {
            ...baseExecuteResult,
            markdown,
          };

          mergeHandlerResults(
            context.target.preEngineExecuteResults,
            mappedExecuteResult,
            context,
          );
          mergeHandlerResults(results, mappedExecuteResult, context);

          // process ojs
          const { executeResult, resourceFiles: ojsResourceFiles } =
            await ojsExecuteResult(
              context,
              mappedExecuteResult,
              ojsBlockLineNumbers,
            );
          resourceFiles.push(...ojsResourceFiles);

          // keep md if requested
          const keepMd = executionEngineKeepMd(context);
          if (keepMd && context.format.execute[kKeepMd]) {
            if (
              keepMdCollidesWithFormatOutput(
                keepMd,
                context.siblingFormatOutputs,
              )
            ) {
              warning(
                `${
                  basename(context.target.input)
                }: not saving the keep-md intermediate because its ` +
                  `conventional location (${
                    basename(keepMd)
                  }) is the output file of another format`,
              );
            } else {
              Deno.writeTextFileSync(keepMd, executeResult.markdown.value);
            }
          }

          // now get "unmapped" execute result back to send to pandoc
          unmappedExecuteResult = {
            ...executeResult,
            markdown: executeResult.markdown.value,
          };
        });

        // Ensure that we have rendered any notebooks
        await ensureNotebookContext(
          unmappedExecuteResult!.markdown,
          context.options.services,
          project,
        );

        // callback
        pushTiming("render-pandoc");
        await pandocRenderer.onRender(format, {
          context,
          recipe,
          executeResult: unmappedExecuteResult!,
          resourceFiles,
        }, pandocQuiet);
        popTiming();
      } finally {
        popTiming();
      }
    }
  }
  await pandocRenderer.onPostProcess(outputs, project);
}

// default pandoc renderer immediately renders each execute result
function defaultPandocRenderer(
  _options: RenderOptions,
  _project: ProjectContext,
): PandocRenderer {
  const renderCompletions: PandocRenderCompletion[] = [];
  const renderedFiles: RenderedFile[] = [];

  return {
    onFilterContexts: (
      _file: string,
      contexts: Record<string, RenderContext>,
      _files: RenderFile[],
      _options: RenderOptions,
    ) => {
      return contexts;
    },
    onBeforeExecute: (_format: Format) => ({}),
    onRender: async (
      _format: string,
      executedFile: ExecutedFile,
      quiet: boolean,
    ) => {
      renderCompletions.push(await renderPandoc(executedFile, quiet));
    },
    onPostProcess: async (renderedFormats: RenderedFormat[]) => {
      let completion = renderCompletions.pop();
      while (completion) {
        renderedFiles.push(await completion.complete(renderedFormats));
        completion = renderCompletions.pop();
      }
      renderedFiles.reverse();
    },
    onComplete: async () => {
      return {
        files: await Promise.resolve(renderedFiles),
      };
    },
  };
}
class RenderInvalidYAMLError extends YAMLValidationError {
  constructor() {
    super("Render failed due to invalid YAML.");
  }
}
