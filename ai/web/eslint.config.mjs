import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

// ESLint 9 flat config. eslint-config-next still ships eslintrc-format configs,
// so we bridge them with FlatCompat — the standard Next 15 + ESLint 9 setup.
// This replaces the deprecated, interactive `next lint` so lint runs unattended
// in CI (HOMELAB-41).
const __dirname = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "prisma/migrations/**",
      "next-env.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals"),
];

export default config;
