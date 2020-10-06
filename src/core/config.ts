import { dirname, join } from "path/mod.ts";
import { exists } from "fs/exists.ts";
import { parse } from "encoding/yaml.ts";

import { ld } from "lodash/mod.ts";

import { metadataFromFile, metadataFromMarkdown } from "./metadata.ts";
import type { FormatOptions } from "../api/format.ts";

export interface QuartoConfig {
  [key: string]: FormatOptions;
}

export async function configFromMarkdown(
  markdown: string,
): Promise<QuartoConfig> {
  return (await metadataFromMarkdown(markdown)).quarto || {};
}

export async function configFromMarkdownFile(
  file: string,
): Promise<QuartoConfig> {
  return (await metadataFromFile(file)).quarto || {};
}

export async function projectConfig(file: string): Promise<QuartoConfig> {
  file = await Deno.realPath(file);
  let dir: string | undefined;
  while (true) {
    // determine next directory to inspect (terminate if we can't go any higher)
    if (!dir) {
      dir = dirname(file);
    } else {
      const nextDir = dirname(dir);
      if (nextDir === dir) {
        return {};
      } else {
        dir = nextDir;
      }
    }

    // see if there is a quarto yml file there
    const quartoYml = join(dir, "_quarto.yml");
    if (await exists(quartoYml)) {
      const decoder = new TextDecoder("utf-8");
      const yml = await Deno.readFile(quartoYml);
      const config = parse(decoder.decode(yml)) as QuartoConfig;
      return resolveConfig(config);
    }
  }
}

// resolve 'default' configs and merge common options
export function resolveConfig(config: QuartoConfig) {
  // config to return
  const newConfig = { ...config };

  // resolve 'default'
  Object.keys(newConfig).forEach((key) => {
    if (typeof newConfig[key] === "string") {
      newConfig[key] = {};
    }
  });

  if (newConfig.common) {
    // pull out common
    const common = newConfig.common;
    delete newConfig.common;

    // merge with each format
    Object.keys(newConfig).forEach((key) => {
      newConfig[key] = mergeFormatOptions(common, newConfig[key]);
    });
  }

  return newConfig;
}

export function mergeFormatOptions(...options: FormatOptions[]): FormatOptions {
  return ld.mergeWith(options[0], ...options.slice(1), arrayMerger);
}

export function mergeConfigs(...configs: QuartoConfig[]): QuartoConfig {
  return ld.mergeWith(configs[0], ...configs.slice(1), arrayMerger);
}

export function arrayMerger(objValue: unknown, srcValue: unknown) {
  if (ld.isArray(objValue) && ld.isArray(srcValue)) {
    const combined = (objValue as Array<unknown>).concat(
      srcValue as Array<unknown>,
    );
    return ld.uniqBy(combined, ld.toString);
  }
}
