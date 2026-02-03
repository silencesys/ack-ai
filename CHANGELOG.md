# Changelog

All notable changes to the Ack-AI extension will be documented in this file.

## [1.0.1] - 2026-02-03

### Bug Fixes

- **Fixed TypeScript function highlighting** - Resolved an issue where TypeScript functions were not being highlighted correctly

## [1.0.0] - 2026-01-18

### 🎉 Major Release - Extended Language Support

This release dramatically expands Ack-AI's language support from 3 to 25+ programming languages.

### New Features

- **Python support** - Full support for Python docstrings (`"""` and `'''`) and hash comments (`#`) with indentation-based block detection
- **C-style language support** - Added Java, C, C++, C#, Go, Rust, Swift, Kotlin, Scala, Dart, Groovy, and Objective-C
- **Hash-comment language support** - Added Ruby, Shell/Bash, Perl, R, YAML, Dockerfile, Makefile, CoffeeScript, PowerShell, and Elixir
- **Smart block detection for Python** - Automatically detects function/class boundaries using Python's indentation rules
- **Regex literal handling** - Properly skips regex literals in JavaScript/TypeScript to prevent false matches
- **Toggle reviewed code indicators** - New command `Ack-AI: Toggle Reviewed Code Indicators` to show/hide blue gutter indicator on reviewed (`@ai-gen ok`) code blocks

### New Settings

- `ackAi.showReviewedIndicators` - Permanently enable/disable gutter indicators for reviewed code (default: `false`). Can also be toggled via command palette.
- `ackAi.allowedColor` - Customize the color of the gutter indicator for reviewed code (default: `rgba(0, 77, 255, 0.1)`)

### Performance Improvements

- **Pre-compiled regex patterns** - Avoids creating new RegExp objects on every tag match
- **Batched time-slicing checks** - Reduces `Date.now()` overhead by checking only every 10 iterations
- **Limited complex content scanning** - Caps scan range at 2000 characters for large blocks
- **Optimized string skipping** - Pass text length to inner loops to avoid repeated property access

### Bug Fixes

- **Fixed doc-block vs file-level detection** - Doc-blocks (`/** */`) at the start of a file now correctly highlight only the following function, not the entire file
- **Fixed Python block detection** - Non-indented comments now correctly end the block instead of being included
- **Fixed brace matching for typed functions** - Complex TypeScript signatures with inline types like `{ key: value }` in parameters are now handled correctly

### Documentation

- Updated README with comprehensive language support list organized by comment style
- Added file-level tag feature to feature list

## [0.0.2] - 2026-01-17

### New Features

- **File-level highlighting** - When `@ai-gen` appears at the top of a file (before any code), the entire file is highlighted, making it easy to identify fully AI-generated files at a glance
- **Smart brace matching** - Code block detection now properly handles braces inside strings, template literals, and comments, preventing incorrect highlighting boundaries
- **Extension icon** - Added a 256x256 icon for the VS Code Marketplace

### New Settings

- `ackAi.detectFileLevelComments` (default: `true`) - Toggle file-level comment detection on/off

### Improvements

- Hybrid parsing approach for better performance: fast path for simple code, careful parsing only when strings/comments are detected
- Enhanced cleanup on extension deactivation to prevent resource leaks

### Documentation

- Updated README with centered logo and screenshot placeholders
- Added visual examples for warning and reviewed states

## [0.0.1] - Initial Release

### Features

- Real-time detection of `@ai-gen` tags in docblocks and inline comments
- Visual highlighting of unverified AI-generated code (yellow background)
- Support for rejected state with red highlighting
- Configurable tags, allowed states, and rejected states
- Customizable highlight colors
- Support for PHP, JavaScript, TypeScript, JSX, and TSX files
