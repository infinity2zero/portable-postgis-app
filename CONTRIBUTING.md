# Contributing to Portable PostGIS App

Thank you for your interest in contributing. This document provides guidelines for contributing to the project.

## Code of Conduct

This project adheres to a [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## How to Contribute

### Reporting Bugs

- Use the [GitHub Issues](https://github.com/infinity2zero/portable-postgis-app/issues) page.
- Include your OS and version, steps to reproduce, and expected vs actual behavior.
- Check existing issues to avoid duplicates.

### Suggesting Features

- Open an issue with the `enhancement` label or use the issue template if available.
- Describe the use case and, if possible, a proposed approach.

### Pull Requests

1. **Fork** the repository and create a branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/short-description
   ```

2. **Set up** the project locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/portable-postgis-app.git
   cd portable-postgis-app
   npm install
   cd renderer && npm install && cd ..
   ```

3. **Make your changes** and keep them focused. Follow existing code style (indentation, naming).

4. **Test** that the app still runs:
   ```bash
   npm run build:renderer
   npm start
   ```

5. **Commit** with clear messages:
   ```bash
   git add .
   git commit -m "feat: add short description"
   ```

6. **Push** and open a Pull Request against `main`:
   - Describe what the PR does and how to test it.
   - Reference any related issues (e.g. "Fixes #123").

## Development

- **Renderer** (Angular): `renderer/` — UI and database browser.
- **Main process**: `main.js`, `src-main/` — Electron main process and PostgreSQL orchestration.
- **Resources**: Place PostgreSQL (and optionally Python) in `bin/win/` or `bin/mac/` (see README for setup).

For live reload during UI development:

```bash
npm run dev
```

## Code Style

- Use existing patterns in the file you edit (tabs vs spaces, quote style).
- Keep functions and components reasonably small; add comments for non-obvious logic.

## License

By contributing, you agree that your contributions will be licensed under the same license as the project (see [LICENSE.md](LICENSE.md)).
