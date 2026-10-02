import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "packages/plugin/src/vencord.ts"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
);
