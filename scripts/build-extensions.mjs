/**
 * Minifies the theme app extension's JavaScript into its assets folder.
 *
 * Theme app extensions have no build pipeline of their own and only allow the
 * assets/, blocks/, snippets/ and locales/ directories, so the readable sources
 * live in extensions-src/ and this writes the shipped files. Minifying also
 * keeps price-calculator.js under theme check's 10 KB app-block JS limit.
 *
 * Runs automatically before `npm run dev` and `npm run deploy`.
 * Use `npm run watch:extensions` while editing the sources.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, context } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "extensions-src", "price-calculator");
const outdir = path.join(root, "extensions", "price-calculator", "assets");

const options = {
  entryPoints: [
    path.join(sourceDir, "price-calculator.js"),
    path.join(sourceDir, "checkout-interceptor.js"),
    path.join(sourceDir, "cart-quantity.js"),
  ],
  outdir,
  minify: true,
  target: ["es2017"],
  legalComments: "none",
  banner: {
    js: "/* Built from extensions-src/price-calculator. Edit that, not this. */",
  },
  logLevel: "warning",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("Watching extension sources for changes…");
} else {
  await build(options);
  console.log("Built theme extension assets.");
}
