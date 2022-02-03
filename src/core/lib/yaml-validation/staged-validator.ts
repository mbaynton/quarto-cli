/*
* staged-validator.ts
*
* Copyright (C) 2022 by RStudio, PBC
*
*/

import { getSchemaDefinition, hasSchemaDefinition, Schema } from "./schema.ts";
import { resolveSchema } from "./schema-utils.ts";
import { validate } from "./validator.ts";
import { ErrorObject } from "./ajv-error.ts";

type StagedValidatorResult = ErrorObject[];

// deno-lint-ignore no-explicit-any
let _module: any = undefined;

let validatorModulePath = "";
// FIXME there's still a race here if ensureValidatorModule gets called twice in quick succession...
export async function ensureValidatorModule() {
  if (_module) {
    return _module;
  }

  if (validatorModulePath === "") {
    throw new Error("Internal Error: validator module path is not set");
  }

  const path = new URL(validatorModulePath, import.meta.url).href;
  try {
    const _mod = await import(path);
    _module = _mod.default;
    return _module;
  } catch (e) {
    // the IDE webworker support doesn't include modules, so we need
    // to do this the old-fashioned way.
    const response = await fetch(path.slice(0, -3) + ".cjs");
    const text = await response.text();

    // self instead of window because we're in a web worker scope here.

    // deno-lint-ignore no-explicit-any
    (self as any).exports = {};

    // self.eval instead of eval, because https://esbuild.github.io/content-types/#direct-eval
    // deno-lint-ignore no-explicit-any
    (self as any).eval(text); // oh yeah we're doing this.
    // deno-lint-ignore no-explicit-any
    _module = (self as any).exports.default;
    // deno-lint-ignore no-explicit-any
    delete (self as any).exports;
    return _module;
  }
}

// we can't hardcode this because it's different from IDE and CLI
// and we're in core/lib so can't call resourcePath() anyway.
export function setValidatorModulePath(
  path: string,
) {
  validatorModulePath = path;
}

// "any" here is actually the complicated function from ajv
// which mutates its own function callable, so I don't know
// how to get a good typing for it
export function setObtainFullValidator(
  compiler: ((schema: Schema) => any),
) {
  obtainFullValidator = compiler;
}

let obtainFullValidator: ((schema: Schema) => any) = (schema: Schema) =>
  undefined;

export function stagedValidator(
  schema: Schema,
): (schema: Schema) => Promise<ErrorObject[]> {
  schema = resolveSchema(schema);

  return async (value) => {
    if (validate(value, schema)) {
      return [];
    }
    await ensureValidatorModule();
    const validator = _module[schema.$id] || obtainFullValidator(schema);
    if (validator === undefined) {
      throw new Error(
        `Internal error: ${schema.$id} not compiled and schema compiler not available`,
      );
    }
    if (validator(value)) {
      throw new Error(
        `Internal error: validators disagree on schema ${schema.$id}`,
      );
    }

    // we don't call cloneDeep here to avoid pulling lodash into core/lib
    return JSON.parse(JSON.stringify(validator.errors)) as ErrorObject[];
  };
}
