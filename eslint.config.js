import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["coverage/**", "dist/**", "node_modules/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["public/**/*.js"],
    languageOptions: {
      globals: {
        clearTimeout: "readonly",
        document: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        navigator: "readonly",
        setTimeout: "readonly",
        window: "readonly",
      },
    },
  },
);
