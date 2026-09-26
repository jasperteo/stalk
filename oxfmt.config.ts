import { defineConfig } from "oxfmt";

const oxfmtConfig = defineConfig({
	embeddedLanguageFormatting: "auto",
	jsdoc: true,
	trailingComma: "es5",
	useTabs: true,

	/*
	 * Import groups, in the order of eslint-plugin-simple-import-sort's defaults, with a blank line
	 * between groups:
	 *
	 * 1. Side-effect imports (`import "x"`).
	 * 2. Node builtins (`node:buffer`).
	 * 3. Packages (`valibot`, `@std/fmt/colors`).
	 * 4. The `@/` alias, `#` subpath imports, and anything unclassified.
	 * 5. Relative imports.
	 *
	 * Within a group, imports sort by module name, ascending and case-insensitive. Two things are
	 * left to the author. oxfmt keeps an `import type` and a value import from the same module in
	 * the order they are written, and this codebase writes the type import first. It also never
	 * sorts the names inside `{ }`.
	 */
	sortImports: {
		order: "asc",
		ignoreCase: true,
		newlinesBetween: true,
		internalPattern: ["~/", "@/"],
		groups: [
			["side_effect", "side_effect_style"],
			"builtin",
			"external",
			["internal", "subpath", "unknown"],
			["parent", "sibling", "index", "style"],
		],
	},
});

export default oxfmtConfig;
