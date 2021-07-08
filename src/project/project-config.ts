/*
* project-config.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { join } from "path/mod.ts";

import { ld } from "lodash/mod.ts";

import { safeExistsSync } from "../core/path.ts";

import { readInputTargetIndex } from "./project-index.ts";
import { fileExecutionEngine } from "../execute/engine.ts";

export const kAriaLabel = "aria-label";
export const kCollapseLevel = "collapse-level";
export const kCollapseBelow = "collapse-below";

export type LayoutBreak = "" | "sm" | "md" | "lg" | "xl" | "xxl";

export interface Navbar {
  title?: string;
  logo?: string;
  type?: "dark" | "light";
  background:
    | "primary"
    | "secondary"
    | "success"
    | "danger"
    | "warning"
    | "info"
    | "light"
    | "dark";
  search?: boolean | string;
  left?: NavbarItem[];
  right?: NavbarItem[];
  collapse?: boolean;
  pinned?: boolean;
  [kCollapseBelow]?: LayoutBreak;
  darkToggle?: boolean;
}

export interface NavbarItem {
  // core identification
  id?: string;
  text?: string;

  // href + more readable/understndable aliases
  href?: string;
  file?: string;
  url?: string;

  // more
  icon?: string;
  [kAriaLabel]?: string;
  menu?: NavbarItem[];
}

export interface Sidebar {
  id?: string;
  title?: string;
  subtitle?: string;
  logo?: string;
  aligment?: "left" | "right" | "center";
  background?:
    | "none"
    | "primary"
    | "secondary"
    | "success"
    | "danger"
    | "warning"
    | "info"
    | "light"
    | "dark"
    | "white";
  type?: "light" | "dark";
  search?: boolean | string;
  [kCollapseLevel]?: number;
  contents: SidebarItem[];
  tools: SidebarTool[];
  style: "docked" | "floating";
  pinned?: boolean;
}

export interface SidebarItem {
  // core structure/contents
  section?: string;
  text?: string;
  contents?: SidebarItem[];

  // href + more readable/understndable aliases
  href?: string;
  file?: string;
  url?: string;

  // more
  [kAriaLabel]?: string;
  expanded?: boolean;
  active?: boolean;
}

export interface SidebarTool {
  // label/contents
  icon: string;
  text?: string;
  menu?: NavbarItem[];

  // href + more readable/understndable aliases
  href?: string;
  file?: string;
  url?: string;
}

export function normalizeSidebarItem(
  projectDir: string,
  item: SidebarItem,
): SidebarItem {
  // clone so we can mutate
  item = ld.cloneDeep(item);

  if (typeof (item) === "string") {
    if (safeExistsSync(join(projectDir, item))) {
      item = {
        href: item,
      };
    } else {
      item = {
        text: item,
      };
    }
  } else {
    // resolve aliases for href
    resolveHrefAttribute(item);

    // section is a special key that can provide either text or href
    // for an item with 'contents'
    const section = item.section;
    if (section) {
      const sectionPath = join(projectDir, section);
      if (safeExistsSync(sectionPath) && Deno.statSync(sectionPath).isFile) {
        item.href = section;
      } else {
        item.text = section;
      }
      delete item.section;
    }

    // handle subitems
    if (item.contents) {
      for (let i = 0; i < item.contents.length; i++) {
        item.contents[i] = normalizeSidebarItem(
          projectDir,
          item.contents[i],
        );
      }
    }
  }

  return item;
}

export function resolveHrefAttribute(
  item: { href?: string; file?: string; url?: string },
) {
  item.href = item.href || item.file || item.url;
  delete item.file;
  delete item.url;
}

export async function partitionedMarkdownForInput(
  projectDir: string,
  input: string,
) {
  // first see if we can get the partioned markdown out of the index
  const index = readInputTargetIndex(projectDir, input);
  if (index) {
    return index.markdown;
    // otherwise fall back to calling the engine to do the partition
  } else {
    const inputPath = join(projectDir, input);
    const engine = fileExecutionEngine(inputPath);
    if (engine) {
      return await engine.partitionedMarkdown(inputPath);
    } else {
      return undefined;
    }
  }
}
