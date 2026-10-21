# @wayora/config

Shared TypeScript presets. Every workspace extends one of these so compiler
strictness stays identical across the monorepo.

| Preset                  | Used by                               |
| ----------------------- | ------------------------------------- |
| `tsconfig.node.json`    | `apps/api`, `apps/worker`, `database` |
| `tsconfig.library.json` | `packages/contracts`, `packages/ui`   |
| `tsconfig.react.json`   | `apps/web`                            |

ESLint and Prettier are configured once at the repository root
(`eslint.config.js`, `.prettierrc.json`).
