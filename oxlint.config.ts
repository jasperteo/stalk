import { defineConfig } from "oxlint";

const oxlintConfig = defineConfig({
	plugins: ["typescript", "unicorn", "oxc"],
	categories: { correctness: "error" },
	options: { typeAware: true, typeCheck: true },
	env: { builtin: true, es2026: true },
	rules: {
		"@typescript-eslint/no-import-type-side-effects": "error",
		"@typescript-eslint/consistent-type-imports": "error",
		"@typescript-eslint/consistent-type-exports": "error",
		"@typescript-eslint/consistent-type-definitions": ["error", "type"],
	},
});

export default oxlintConfig;
