/*
* book-bibliography.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { dirname, join, relative } from "path/mod.ts";

import { ld } from "lodash/mod.ts";
import { stringify } from "encoding/yaml.ts";
import { error } from "log/mod.ts";

import { Element } from "deno_dom/deno-dom-wasm.ts";

import { pathWithForwardSlashes } from "../../../core/path.ts";
import { execProcess } from "../../../core/process.ts";
import { binaryPath } from "../../../core/resources.ts";

import { kBibliography, kCsl } from "../../../config/constants.ts";
import { Metadata } from "../../../config/metadata.ts";

import { normalizeSidebarItem, SidebarItem } from "../../project-config.ts";
import { ProjectContext, projectOutputDir } from "../../project-context.ts";
import { resolveInputTarget } from "../../project-index.ts";
import { WebsiteProjectOutputFile } from "../website/website.ts";
import { bookConfig, kBookReferences } from "./book-config.ts";

export async function bookBibliographyPostRender(
  context: ProjectContext,
  outputFiles: WebsiteProjectOutputFile[],
) {
  // get (required) references config
  const references = bookConfig(kBookReferences, context.config) as SidebarItem;
  if (!references) {
    return;
  }

  // make sure the references file exists and compute it's path
  let refsHtml: string | undefined;
  const refsItem = normalizeSidebarItem(context.dir, references);
  if (refsItem.href) {
    const refsTarget = await resolveInputTarget(
      context,
      refsItem.href,
      false,
    );
    if (refsTarget) {
      refsHtml = join(projectOutputDir(context), refsTarget.outputHref);
    }
  }

  // bail if there is no target refs file
  if (refsHtml && outputFiles.length > 0) {
    // determine the bibliography and the csl based on the first file
    const file = outputFiles[0];
    const bibliography = file.format.metadata[kBibliography];
    const csl = file.format.metadata[kCsl];
    if (!bibliography) {
      return;
    }

    // find all of the refs in each document and fixup their links to point
    // to the shared bibliography output. note these refs so we can generate
    // a global bibliography. also hide the refs div in each document (as it's
    // still used by hover-citations)
    const citeIds: string[] = [];
    outputFiles.forEach((file) => {
      // relative path to refs html
      const refsRelative = pathWithForwardSlashes(
        relative(dirname(file.file), refsHtml!),
      );
      // check each citation
      const cites = file.doc.querySelectorAll(".citation");
      for (let i = 0; i < cites.length; i++) {
        // get cite
        const cite = cites[i] as Element;
        // record id
        const citeTarget = cite.getAttribute("data-cites");
        if (citeTarget) {
          citeIds.push(...citeTarget.split(" "));
        }
        // fix hrefs
        const citeLinks = cite.querySelectorAll("a[role='doc-biblioref']");
        for (let l = 0; l < citeLinks.length; l++) {
          const link = citeLinks[l] as Element;
          link.setAttribute("href", refsRelative + link.getAttribute("href"));
        }
      }
      // hide the bibliography
      const refsDiv = file.doc.getElementById("refs");
      if (refsDiv) {
        refsDiv.setAttribute("style", "display: none");
      }
    });

    if (citeIds.length > 0) {
      // genereate bibliography html
      const biblioHtml = await generateBibliographyHTML(
        context,
        bibliography,
        csl,
        citeIds,
      );

      // either append this to the end of the references file or replace an explicit
      // refs div in the references file
      const refsOutputFile = outputFiles.find((file) => file.file === refsHtml);
      if (refsOutputFile) {
        const newRefsDiv = refsOutputFile.doc.createElement("div");
        newRefsDiv.innerHTML = biblioHtml;
        const refsDiv = refsOutputFile.doc.getElementById("refs") as Element;
        if (refsDiv) {
          refsDiv.replaceWith(newRefsDiv.firstChild);
        } else {
          const mainEl = refsOutputFile.doc.querySelector("main");
          if (mainEl) {
            mainEl.appendChild(newRefsDiv.firstChild);
          }
        }
      }
    }
  }
}

async function generateBibliographyHTML(
  context: ProjectContext,
  bibliography: unknown,
  csl: unknown,
  citeIds: string[],
) {
  // make the aggregated bibliography
  const yaml: Metadata = {
    bibliography,
    nocite: ld.uniq(citeIds).map((id) => "@" + id).join(", "),
  };
  if (csl) {
    yaml[kCsl] = csl;
  }
  const frontMatter = `---\n${stringify(yaml, { indent: 2 })}\n---\n`;
  const result = await execProcess({
    cmd: [
      binaryPath("pandoc"),
      "--from",
      "markdown",
      "--to",
      "html",
      "--citeproc",
    ],
    cwd: context.dir,
    stdout: "piped",
  }, frontMatter);
  if (result.success) {
    return result.stdout!;
    // read
  } else {
    error(result.stderr);
    throw new Error();
  }
}
