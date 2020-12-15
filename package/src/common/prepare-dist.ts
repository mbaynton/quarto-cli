import { dirname, join } from "https://deno.land/std/path/mod.ts";
import { copySync } from "https://deno.land/std/fs/mod.ts";
import { Configuration } from "../common/config.ts";
import { Logger } from "./logger.ts";
import { buildFilter } from "./package-filters.ts";
import { bundle } from "./deno.ts";
import { ensureDirExists } from "./utils.ts";


export async function prepareDist(
  config: Configuration) {
  const log = config.log;

  // Move the supporting files into place
  log.info("\nMoving supporting files")
  supportingFiles(config, log);
  log.info("")


  log.info("\nCreating Deno Bundle")
  // Create the deno bundle
  const input = join(config.dirs.src, "quarto.ts");
  const output = join(config.dirs.bin, "quarto.js");
  await bundle(
    input,
    output,
    config,
  );
  log.info("")

  // Inline the LUA Filters and move them into place
  log.info("\nCreating Inlined LUA Filters")
  inlineFilters(config);
  log.info("")
}

function supportingFiles(config: Configuration, log: Logger) {
  // Move information and share resources into place
  const filesToCopy = [
    {
      from: join(config.dirs.root, "COPYING.md"),
      to: join(config.dirs.dist, "COPYING.md"),
    },
    {
      from: join(config.dirs.root, "COPYRIGHT"),
      to: join(config.dirs.dist, "COPYRIGHT"),
    },
    {
      from: join(config.dirs.src, "resources", "html-defaults.lua"),
      to: join(config.dirs.share, "html-defaults.lua"),
    },
    {
      from: join(config.dirs.src, "resources", "rmd"),
      to: join(config.dirs.share, "rmd"),
    },
    {
      from: join(config.dirs.src, "resources", "jupyter"),
      to: join(config.dirs.share, "jupyter"),
    },
  ];

  // Gather supporting files
  filesToCopy.forEach((fileToCopy) => {
    log.info(`Copying ${fileToCopy.from} to ${fileToCopy.to}`);

    const dir = dirname(fileToCopy.to);
    log.info(`Ensuring dir ${dir} exists`);
    if (ensureDirExists(dir)) {
      log.info(`Created dir ${dir}`);
    }
    copySync(fileToCopy.from, fileToCopy.to, { overwrite: true });
  });
}

function inlineFilters(config: Configuration) {
  config.log.info("Building inlined filters");
  const outDir = join(config.dirs.share, "filters");
  const filtersToInline = ["crossref", "figures"];

  filtersToInline.forEach((filter) => {
    config.log.info(filter);
    buildFilter(
      join(
        config.dirs.src,
        "resources",
        "filters",
        filter,
        `${filter}.lua`,
      ),
      join(outDir, filter, `${filter}.lua`),
      config.log,
    );
  });
}
