# SuperFind

One search box for your whole project, like JetBrains' Search Everywhere — but for VS Code.

`Alt+F` (`Cmd+Alt+F` on Mac) opens a quick-pick in the middle of the screen. Type anything and it searches, in order:

1. **Symbols** — classes, functions, variables, matched by name.
2. **Usages** — for each matched symbol, every place it's called/referenced (same data as "Find All References", just inline here).
3. **Styles** — SCSS/CSS/LESS classes (nested BEM like `&__title--large` resolved to the full name), ids, `%placeholders`, `@mixin`s and `$variables`, plus where they're used (class names in TSX/JSX/HTML/Vue…, `@include`, `@extend`). Prefix with `.`, `#`, `%` or `@mixin ` to search only that kind.
4. **Files** — fuzzy path match.
5. **Folders** — fuzzy match, jumps to it in the Explorer.
6. **Content** — only kicks in if nothing above matched anything. Searches file contents (e.g. `payload.find(`), so you can find a piece of code even if it's not a named symbol.

Enter jumps straight to the result.

## Install

Download the latest `.vsix` from [Releases](https://github.com/Inspiractus01/superfind/releases), then:

```bash
code --install-extension superfind.vsix
```

Or, one line:

```bash
curl -sL -o /tmp/superfind.vsix https://github.com/Inspiractus01/superfind/releases/latest/download/superfind.vsix && code --install-extension /tmp/superfind.vsix
```

## License

MIT
