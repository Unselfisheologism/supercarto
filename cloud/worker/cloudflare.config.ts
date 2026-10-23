import { defineConfig } from "cf/config";

export default defineConfig({
	worker: {
		name: "supercarto-compile",
		compatibilityDate: "2025-12-01",
		entrypoint: "src/worker.ts",
	},
});
