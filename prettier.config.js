// @ts-check
// Prettier's project config. It exists so the CLI (`pnpm format`, CI's
// `pnpm format:check`) and the editor extension read the SAME settings.
// Without it, each one used its own defaults, and every save in VS Code
// undid what `pnpm format` had done (and CI's format check failed).
// When the VS Code extension finds this file, it ignores its own formatting
// settings, so this file is the only place to change them.
//
// A .js file (instead of .prettierrc JSON) so these lines can have comments.
// Everything not listed here keeps Prettier's default on purpose: double
// quotes, semicolons, 2-space indent and trailing commas everywhere, which is
// how the code is already written.

/** @type {import("prettier").Config} */
const config = {
  // Maximum line length Prettier aims for. The default (80) wraps type-heavy
  // lines such as `expectTypeOf<X>().not.toExtend<Y["content"][number]>()`
  // into three lines. 100 keeps those on one line while still fitting two
  // files side by side in a diff view.
  printWidth: 100,
};

export default config;
