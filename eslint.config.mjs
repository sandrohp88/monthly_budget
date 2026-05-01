import { FlatCompat } from "@eslint/eslintrc";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

export default [
  {
    ignores: [
      // Use **/ prefix so worktrees, monorepo roots, etc. also get ignored —
      // ".next/**" only matches at the eslint root, but a git worktree at
      // .claude/worktrees/<name>/ creates its own nested .next/ which would
      // otherwise lint the generated server bundles.
      "**/node_modules/**",
      "**/.next/**",
      "**/out/**",
      "**/dist/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "lib/db/migrations/**",
      "data/**",
      "backups/**",
      "**/next-env.d.ts",
      "scripts/_*",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "import/no-anonymous-default-export": "off",
    },
  },
];
