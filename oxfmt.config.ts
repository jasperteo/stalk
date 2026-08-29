import { defineConfig } from "oxfmt";

const oxfmtConfig = defineConfig({
	embeddedLanguageFormatting: "auto",
	jsdoc: true,
	trailingComma: "es5",
	useTabs: true,

	/*
	 * Mirrors eslint-plugin-simple-import-sort's default groups. oxfmt implements
	 * eslint-plugin-perfectionist's algorithm, so the grouping translates but the comparator does
	 * not. Three differences have no configuration:
	 *
	 * - simple-import-sort puts `import type` before the value import of the same source. oxfmt
	 *   leaves same-source ties in author order, so write the type import first to match.
	 * - simple-import-sort sorts the named specifiers inside `{ }`. oxfmt never touches them.
	 * - simple-import-sort compares a transformed key through an ICU collator, so directory depth
	 *   beats string length (`a.b` < `a/b` < `a_b` < `a-b` < `ab`). oxfmt compares raw code points
	 *   (`a-b` < `a.b` < `a/b` < `a_b` < `ab`). Both are case-insensitive and numeric-aware.
	 *
	 * Grouping then differs only for shapes this repo doesn't use: a builtin written without the
	 * `node:` prefix lands in `builtin` rather than with the packages, an absolute `/x.ts` lands in
	 * `external` rather than the catch-all, and `style` covers both `./x.css` (grouped with the
	 * relatives below, as simple-import-sort does) and `pkg/x.css` (which it would group with the
	 * packages). customGroups splits none of them: `node:**` misses `node:fs/promises`, and a
	 * `style` custom group pulls side-effect `.css` imports out of the first group.
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
