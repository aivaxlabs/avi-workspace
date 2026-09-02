---
description: Cascadium XCSS authoring, organization, and validation rules for the styles subtree.
---
# Styles agent guide

## Scope
- Author styles only in `styles/**/*.xcss`. The build concatenates them into `../src/styles.css`; never edit that generated file directly.
- `tokens.xcss` owns global tokens, resets, shared focus behavior, and reduced-motion handling.
- `components/` owns reusable workspace/chat component styles; `pages/` owns page-level surfaces; `vendor/` is reserved for vendor styles and compiles first.

## Cascadium conventions
- Inspect the corresponding Preact markup and adjacent XCSS before changing selectors.
- Organize related rules under the nearest stable component or layout root. Put root declarations first, then `&` states/modifiers, confirmed `>` children, deeper descendants, and relevant media rules.
- Use `&` for composition with the current selector, not for ordinary descendants: Cascadium joins it to the parent unless `KeepNestingSpace` is enabled, and this project does not enable that option.
- Use the custom-property shortcut already established here (`color: --text-secondary`); Cascadium emits `var(--text-secondary)` in generated CSS.
- Keep responsive rules with the component or page they modify and preserve the existing 860px, 640px, 520px, and 380px behavior where applicable.
- Preserve keyboard focus visibility, WCAG-readable contrast, safe-area handling, and the global `prefers-reduced-motion` override.

## Validation
- Run `bun run styles` from the project root.
- Inspect the affected block in `src/styles.css` for selector shape, specificity, order, and valid `var(...)` output.
- Run the focused DOM test for affected UI behavior, then `bun run build` when the change can affect production layout or asset output.
