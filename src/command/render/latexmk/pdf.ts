/*
 * pdf.ts
 *
 * Copyright (C) 2020 by RStudio, PBC
 *
 */

import { dirname, join } from "path/mod.ts";
import { existsSync } from "fs/mod.ts";

import { PdfEngine } from "../../../config/types.ts";
import { kLatexHeaderMessageOptions, LatexmkOptions } from "./types.ts";

import { dirAndStem } from "../../../core/path.ts";
import { ProcessResult } from "../../../core/process.ts";

import { hasTexLive } from "./texlive.ts";
import { runBibEngine, runIndexEngine, runPdfEngine } from "./latex.ts";
import { PackageManager, packageManager } from "./pkgmgr.ts";
import {
  findIndexError,
  findLatexError,
  findMissingFontsAndPackages,
  findMissingHyphenationFiles,
  kMissingFontLog,
  needsRecompilation,
} from "./parse-error.ts";
import { info, warning } from "log/mod.ts";

export async function generatePdf(mkOptions: LatexmkOptions): Promise<string> {
  if (!mkOptions.quiet) {
    info(
      `runnning ${mkOptions.engine.pdfEngine} - 1`,
      kLatexHeaderMessageOptions,
    );
  }

  // Get the working directory and file name stem
  const [cwd, stem] = dirAndStem(mkOptions.input);
  const workingDir = mkOptions.outputDir ? join(cwd, mkOptions.outputDir) : cwd;

  // Ensure that working directory exists
  if (!existsSync(workingDir)) {
    Deno.mkdirSync(workingDir);
  } else {
    // Clean the working directory of any leftover artifacts
    cleanup(workingDir, stem);
  }

  // Determine whether we support automatic updating (TexLive is available)
  const allowUpdate = await hasTexLive();
  mkOptions.autoInstall = mkOptions.autoInstall && allowUpdate;

  // The package manager used to find and install packages
  const pkgMgr = packageManager(mkOptions);

  // Render the PDF, detecting whether any packages need to be installed
  const response = await initialCompileLatex(
    mkOptions.input,
    mkOptions.engine,
    pkgMgr,
    mkOptions.outputDir,
    mkOptions.texInputDir,
    mkOptions.quiet,
  );
  const initialCompileNeedsRerun = needsRecompilation(response.log);

  // Generate the index information, if needed
  const indexCreated = await makeIndexIntermediates(
    workingDir,
    stem,
    pkgMgr,
    mkOptions.engine.indexEngine,
    mkOptions.engine.indexEngineOpts,
    mkOptions.quiet,
  );

  // Generate the bibliography intermediaries
  const bibliographyCreated = await makeBibliographyIntermediates(
    mkOptions.input,
    mkOptions.engine.bibEngine || "citeproc",
    pkgMgr,
    mkOptions.outputDir,
    mkOptions.quiet,
  );

  // Recompile the Latex if required
  // we have already run the engine one time (hence subtracting one run from min and max)
  const minRuns = (mkOptions.minRuns || 1) - 1;
  const maxRuns = (mkOptions.maxRuns || 10) - 1;
  if (
    (indexCreated || bibliographyCreated || minRuns ||
      initialCompileNeedsRerun) && maxRuns > 0
  ) {
    await recompileLatexUntilComplete(
      mkOptions.input,
      mkOptions.engine,
      pkgMgr,
      mkOptions.minRuns || 1,
      maxRuns,
      mkOptions.outputDir,
      mkOptions.texInputDir,
      mkOptions.quiet,
    );
  }

  // cleanup if requested
  if (mkOptions.clean) {
    cleanup(workingDir, stem);
  }

  if (!mkOptions.quiet) {
    info("");
  }

  return mkOptions.outputDir
    ? join(mkOptions.outputDir, stem + ".pdf")
    : join(cwd, stem + ".pdf");
}

// The first pass compilation of the latex with the ability to discover
// missing packages (and subsequently retrying the compilation)
async function initialCompileLatex(
  input: string,
  engine: PdfEngine,
  pkgMgr: PackageManager,
  outputDir?: string,
  texInputDir?: string,
  quiet?: boolean,
) {
  let packagesUpdated = false;
  while (true) {
    // Run the pdf engine
    const response = await runPdfEngine(
      input,
      engine,
      outputDir,
      texInputDir,
      pkgMgr,
      quiet,
    );

    // Check whether it suceeded. We'll consider it a failure if there is an error status or output is missing despite a success status
    // (PNAS Template may eat errors when missing packages exists)
    // See: https://github.com/yihui/tinytex/blob/6c0078f2c3c1319a48b71b61753f09c3ec079c0a/R/latex.R#L216
    const success = response.result.code === 0 &&
      (!response.output || existsSync(response.output));

    if (success) {
      // See whether there are warnings about hyphenation
      // See (https://github.com/yihui/tinytex/commit/0f2007426f730a6ed9d45369233c1349a69ddd29)
      const logText = Deno.readTextFileSync(response.log);
      const missingHyphenationFile = findMissingHyphenationFiles(logText);
      if (missingHyphenationFile) {
        if (await pkgMgr.installPackages([missingHyphenationFile])) {
          // We installed hyphenation files, retry
          continue;
        } else {
          writeError("missing hyphenation file", "", response.log);
          return Promise.reject();
        }
      }
    } else if (pkgMgr.autoInstall) {
      // try autoinstalling
      // First be sure all packages are up to date
      if (!packagesUpdated) {
        if (!quiet) {
          info("updating tlmgr", kLatexHeaderMessageOptions);
        }
        await pkgMgr.updatePackages(false, true);
        info("");

        if (!quiet) {
          info("updating existing packages", kLatexHeaderMessageOptions);
        }
        await pkgMgr.updatePackages(true, false);
        packagesUpdated = true;
      }

      // Try to find and install packages
      const packagesInstalled = await findAndInstallPackages(
        pkgMgr,
        response.log,
        response.result.stderr,
        quiet,
      );

      if (packagesInstalled) {
        // try the intial compile again
        continue;
      } else {
        // We failed to install packages (but there are missing packages), give up
        displayError(
          "missing packages (automatic installation failed)",
          response.log,
          response.result,
        );
        return Promise.reject();
      }
    } else {
      // Failed, but no auto-installation, just display the error
      displayError(
        "missing packages (automatic installed disabled)",
        response.log,
        response.result,
      );
      return Promise.reject();
    }

    // If we get here, we aren't installing packages (or we've already installed them)
    return Promise.resolve(response);
  }
}

function displayError(title: string, log: string, result: ProcessResult) {
  if (existsSync(log)) {
    // There is a log file, so read that and try to find the error
    const logText = Deno.readTextFileSync(log);
    writeError(
      title,
      findLatexError(logText, result.stderr),
      log,
    );
  } else {
    // There is no log file, just display an unknown error
    writeError(title);
  }
}

async function makeIndexIntermediates(
  dir: string,
  stem: string,
  pkgMgr: PackageManager,
  engine?: string,
  args?: string[],
  quiet?: boolean,
) {
  // If there is an idx file, we need to run makeindex to create the index data
  const indexFile = join(dir, `${stem}.idx`);
  if (existsSync(indexFile)) {
    if (!quiet) {
      info("making index", kLatexHeaderMessageOptions);
    }

    // Make the index
    try {
      const response = await runIndexEngine(
        indexFile,
        engine,
        args,
        pkgMgr,
        quiet,
      );

      // Indexing Failed
      const indexLogExists = existsSync(response.log);
      if (response.result.code !== 0) {
        writeError(
          `result code ${response.result.code}`,
          "",
          response.log,
        );
        return Promise.reject();
      } else if (indexLogExists) {
        // The command succeeded, but there is an indexing error in the lgo
        const logText = Deno.readTextFileSync(response.log);
        const error = findIndexError(logText);
        if (error) {
          writeError(
            `error generating index`,
            error,
            response.log,
          );
          return Promise.reject();
        }
      }
      return true;
    } catch {
      writeError(
        `error generating index`,
      );
      return Promise.reject();
    }
  } else {
    return false;
  }
}

async function makeBibliographyIntermediates(
  input: string,
  engine: string,
  pkgMgr: PackageManager,
  outputDir?: string,
  quiet?: boolean,
) {
  // Generate bibliography (including potentially installing missing packages)
  // By default, we'll use citeproc which requires no additional processing,
  // but if the user would like to use natbib or biblatex, we do need additional
  // processing (including explicitly calling the processing tool)
  const bibCommand = engine === "natbib" ? "bibtex" : "biber";

  const [cwd, stem] = dirAndStem(input);

  while (true) {
    // If biber, look for a bcf file, otherwise look for aux file
    const auxBibFile = bibCommand === "biber" ? `${stem}.bcf` : `${stem}.aux`;
    const auxBibPath = outputDir ? join(outputDir, auxBibFile) : auxBibFile;
    const auxBibFullPath = join(cwd, auxBibPath);

    if (existsSync(auxBibFullPath)) {
      const auxFileData = Deno.readTextFileSync(auxBibFullPath);

      const requiresProcessing = bibCommand === "biber"
        ? true
        : containsBiblioData(auxFileData);

      if (requiresProcessing) {
        if (!quiet) {
          info("generating bibliography", kLatexHeaderMessageOptions);
        }

        // If we're on windows and auto-install isn't enabled,
        // fix up the aux file
        //
        if (Deno.build.os === "windows") {
          if (bibCommand !== "biber" && !hasTexLive()) {
            // See https://github.com/yihui/tinytex/blob/b2d1bae772f3f979e77fca9fb5efda05855b39d2/R/latex.R#L284
            // Strips the '.bib' from any match and returns the string without the bib extension
            // Replace any '.bib' in bibdata in windows auxData
            const fixedAuxFileData = auxFileData.replaceAll(
              /(^\\bibdata{.+)\.bib(.*})$/gm,
              (
                _substr: string,
                prefix: string,
                postfix: string,
              ) => {
                return prefix + postfix;
              },
            );

            // Rewrite the corrected file
            Deno.writeTextFileSync(auxBibFullPath, fixedAuxFileData);
          }
        }

        // If natbib, only use bibtex, otherwise, could use biber or bibtex
        const response = await runBibEngine(
          bibCommand,
          auxBibPath,
          cwd,
          pkgMgr,
          quiet,
        );

        if (response.result.code !== 0 && pkgMgr.autoInstall) {
          // Biblio generation failed, see whether we should install anything to try to resolve
          // Find the missing packages
          const log = join(dirname(auxBibFullPath), `${stem}.blg`);

          if (existsSync(log)) {
            const logOutput = Deno.readTextFileSync(log);
            const match = logOutput.match(/.* open style file ([^ ]+).*/);

            if (match) {
              const file = match[1];
              if (
                await findAndInstallPackages(
                  pkgMgr,
                  file,
                  response.result.stderr,
                  quiet,
                )
              ) {
                continue;
              } else {
                // TODO: read error out of blg file
                // TODO: writeError that doesn't require logText?
                writeError(`error generating bibliography`, "", log);
                return Promise.reject();
              }
            }
          }
        }
        return true;
      }
    }

    return false;
  }
}

async function findAndInstallPackages(
  pkgMgr: PackageManager,
  logFile: string,
  stderr?: string,
  _quiet?: boolean,
) {
  if (existsSync(logFile)) {
    // Read the log file itself
    const logText = Deno.readTextFileSync(logFile);

    const searchTerms = findMissingFontsAndPackages(logText, dirname(logFile));
    if (searchTerms.length > 0) {
      const packages = await pkgMgr.searchPackages(searchTerms);
      if (packages.length > 0) {
        const packagesInstalled = await pkgMgr.installPackages(
          packages,
        );
        if (packagesInstalled) {
          // Try again
          return true;
        } else {
          writeError(
            "package installation error",
            findLatexError(logText, stderr),
            logFile,
          );
          return Promise.reject();
        }
      } else {
        writeError(
          "no matching packages",
          findLatexError(logText, stderr),
          logFile,
        );
        return Promise.reject();
      }
    } else {
      writeError("error", findLatexError(logText, stderr), logFile);
      return Promise.reject();
    }
  }
  return false;
}

function writeError(primary: string, secondary?: string, logFile?: string) {
  info(
    `\ncompilation failed- ${primary}`,
    kLatexHeaderMessageOptions,
  );

  if (secondary) {
    info(secondary);
  }

  if (logFile) {
    info(`see ${logFile} for more information.`);
  }
}

async function recompileLatexUntilComplete(
  input: string,
  engine: PdfEngine,
  pkgMgr: PackageManager,
  minRuns: number,
  maxRuns: number,
  outputDir?: string,
  texInputDir?: string,
  quiet?: boolean,
) {
  // Run the engine until the bibliography is fully resolved
  let runCount = 0;

  // convert to zero based minimum
  minRuns = minRuns - 1;
  while (true) {
    // If we've exceeded maximum runs break
    if (runCount >= maxRuns) {
      if (!quiet) {
        warning(
          `maximum number of runs (${maxRuns}) reached`,
          kLatexHeaderMessageOptions,
        );
      }
      break;
    }

    if (!quiet) {
      info(
        `running ${engine.pdfEngine} - ${runCount + 2}`,
        kLatexHeaderMessageOptions,
      );
    }

    const result = await runPdfEngine(
      input,
      engine,
      outputDir,
      texInputDir,
      pkgMgr,
      quiet,
    );

    if (!result.result.success) {
      // Failed
      displayError("Error compiling latex", result.log, result.result);
      return Promise.reject();
    } else {
      runCount = runCount + 1;
      // If we haven't reached the minimum or the bibliography still needs to be rerun
      // go again.
      if (
        existsSync(result.log) && needsRecompilation(result.log) ||
        runCount < minRuns
      ) {
        continue;
      }
      break;
    }
  }
}

function containsBiblioData(auxData: string) {
  return auxData.match(/^\\(bibdata|citation|bibstyle)\{/m);
}

function auxFile(stem: string, ext: string) {
  return `${stem}.${ext}`;
}

function cleanup(workingDir: string, stem: string) {
  const auxFiles = [
    "log",
    "idx",
    "aux",
    "bcf",
    "blg",
    "bbl",
    "fls",
    "out",
    "lof",
    "lot",
    "toc",
    "nav",
    "snm",
    "vrb",
    "ilg",
    "ind",
    "xwm",
    "brf",
    "run.xml",
  ].map((aux) => join(workingDir, auxFile(stem, aux)));

  // Also cleanup any missfont.log file
  auxFiles.push(join(workingDir, kMissingFontLog));

  auxFiles.forEach((auxFile) => {
    if (existsSync(auxFile)) {
      Deno.removeSync(auxFile);
    }
  });
}
