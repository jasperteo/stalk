import { defineConfig } from "oxlint";

const oxlintConfig = defineConfig({
	plugins: ["typescript", "unicorn", "oxc"],
	categories: { correctness: "error" },
	options: { typeAware: true, typeCheck: true },
	env: { builtin: true, es2026: true },
	// rules: {},
});

export default oxlintConfig;
