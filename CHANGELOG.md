# Changelog

All notable changes to the Ack-AI extension will be documented in this file.

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
