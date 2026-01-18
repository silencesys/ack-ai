export interface DiagnosticMatch {
  tagStartOffset: number;
  tagEndOffset: number;
  codeStartOffset: number;
  codeEndOffset: number;
  type: 'warning' | 'rejected';
  isFileLevel?: boolean; // When true, the entire file should be highlighted
}

export type LanguageType = 'javascript' | 'python' | 'hash';

export interface AnalyzerOptions {
  detectInline: boolean;
  detectFileLevel: boolean;
  tag: string;
  allowedStates: string[];
  rejectedStates: string[];
  language: LanguageType;
}

// Reusable regex patterns for performance (stateless)
// JavaScript/TypeScript patterns
const JS_DOC_BLOCK_PATTERN = /(\/\*\*[\s\S]*?\*\/)/g;
const JS_ALL_COMMENTS_PATTERN = /(\/\*\*[\s\S]*?\*\/|\/\/.*)/g;
// File-level comments are ONLY single-line comments (// ...) at the start of the file.
// Doc-blocks (/** ... */) at the start should document the following function, not mark the whole file.
const JS_FILE_LEVEL_COMMENT_PATTERN = /^(\s*)(\/\/.*)/;

// Python patterns (# comments and """ or ''' docstrings)
const PY_DOC_BLOCK_PATTERN = /("""[\s\S]*?"""|'''[\s\S]*?''')/g;
const PY_ALL_COMMENTS_PATTERN = /("""[\s\S]*?"""|'''[\s\S]*?'''|#.*)/g;
// File-level comments are ONLY hash comments (# ...) at the start of the file.
// Docstrings (""" or ''') at the start should document the following function, not mark the whole file.
const PY_FILE_LEVEL_COMMENT_PATTERN = /^(\s*)(#.*)/;

// Hash-only patterns (# comments, no doc-blocks) - Ruby, Shell, Perl, R, YAML, etc.
const HASH_ALL_COMMENTS_PATTERN = /(#.*)/g;
const HASH_FILE_LEVEL_COMMENT_PATTERN = /^(\s*)(#.*)/;

const NON_WHITESPACE_PATTERN = /\S/g;

// Time-slicing configuration
const YIELD_INTERVAL_MS = 15; // Yield every 15ms to keep UI responsive

/**
 * Analyzes text to find specific tags (default ai-gen) that are not marked as 'ok'.
 * Returns the character offsets needed to create VS Code diagnostics.
 * Uses optimized Regex scanning (O(N)) AND time-slicing to prevent main-thread blocking.
 * @ai-gen ok
 */
export async function findAiGenDiagnostics(text: string, options: Partial<AnalyzerOptions> = {}, token?: { isCancellationRequested: boolean }): Promise<DiagnosticMatch[]> {
  const {
    detectInline = true,
    detectFileLevel = true,
    tag = '@ai-gen',
    allowedStates = ['ok'],
    rejectedStates = ['rejected', 'reject'],
    language = 'javascript'
  } = options;

  // Select patterns based on language
  const isPython = language === 'python';
  const isHash = language === 'hash';
  let docBlockPattern: RegExp;
  let allCommentsPattern: RegExp;
  let fileLevelCommentPattern: RegExp;

  if (isPython) {
    docBlockPattern = PY_DOC_BLOCK_PATTERN;
    allCommentsPattern = PY_ALL_COMMENTS_PATTERN;
    fileLevelCommentPattern = PY_FILE_LEVEL_COMMENT_PATTERN;
  } else if (isHash) {
    // Hash-only languages have no doc-blocks, use inline pattern for both
    docBlockPattern = HASH_ALL_COMMENTS_PATTERN;
    allCommentsPattern = HASH_ALL_COMMENTS_PATTERN;
    fileLevelCommentPattern = HASH_FILE_LEVEL_COMMENT_PATTERN;
  } else {
    docBlockPattern = JS_DOC_BLOCK_PATTERN;
    allCommentsPattern = JS_ALL_COMMENTS_PATTERN;
    fileLevelCommentPattern = JS_FILE_LEVEL_COMMENT_PATTERN;
  }

  const matches: DiagnosticMatch[] = [];

  const allowedStatesSet = new Set(allowedStates.map(s => s.toLowerCase()));
  const rejectedStatesSet = new Set(rejectedStates.map(s => s.toLowerCase()));

  const escapedTag = escapeRegExp(tag);
  const tagRegex = new RegExp(`${escapedTag}\\s*(.*)`, 'i');

  // Check for file-level comment first (comment at the very start of the file)
  let fileLevelCommentEndOffset = -1;
  if (detectFileLevel) {
    const fileLevelResult = checkFileLevelComment(text, tagRegex, allowedStatesSet, rejectedStatesSet, detectInline, fileLevelCommentPattern, isPython || isHash);
    if (fileLevelResult) {
      matches.push(fileLevelResult.match);
      fileLevelCommentEndOffset = fileLevelResult.commentEndOffset;
    }
  }

  const mainPattern = detectInline ? allCommentsPattern : docBlockPattern;
  mainPattern.lastIndex = 0;

  let startTime = Date.now();
  let match;

  while ((match = mainPattern.exec(text)) !== null) {
    // Skip the file-level comment if we already processed it
    if (fileLevelCommentEndOffset !== -1 && match.index < fileLevelCommentEndOffset) {
      continue;
    }
    // Cancellation check
    if (token?.isCancellationRequested) {
      return [];
    }

    // Time-slicing check
    if (Date.now() - startTime > YIELD_INTERVAL_MS) {
      await new Promise(resolve => setImmediate(resolve)); // Yield to event loop
      startTime = Date.now(); // Reset timer
    }

    const fullComment = match[0];
    const commentStartOffset = match.index;
    const commentEndOffset = commentStartOffset + fullComment.length;

    // Check for tag inside the comment
    const tagMatch = tagRegex.exec(fullComment);

    if (tagMatch) {
      const rawContent = tagMatch[1];
      // Clean trailing comment syntax: */ for JS, """ or ''' for Python
      const tagContent = rawContent
        .replace(/\s*\*\/$/, '')       // JS block comment end
        .replace(/\s*(?:"""|''')$/, '') // Python docstring end
        .trim()
        .toLowerCase();

      if (allowedStatesSet.has(tagContent)) {
        continue;
      }

      const type: 'warning' | 'rejected' = rejectedStatesSet.has(tagContent) ? 'rejected' : 'warning';

      const tagStartOffset = commentStartOffset + tagMatch.index;
      const tagEndOffset = tagStartOffset + tagMatch[0].length;

      NON_WHITESPACE_PATTERN.lastIndex = commentEndOffset;
      const codeMatch = NON_WHITESPACE_PATTERN.exec(text);

      if (codeMatch) {
        const codeStartOffset = codeMatch.index;
        let codeEndOffset: number;

        // Determine if this is an inline comment
        const isInlineComment = (isPython || isHash)
          ? fullComment.startsWith('#')
          : fullComment.startsWith('//');

        if (isInlineComment) {
          const nextNewline = text.indexOf('\n', codeStartOffset);
          codeEndOffset = nextNewline !== -1 ? nextNewline : text.length;
        } else if (isPython) {
          codeEndOffset = findPythonBlockEndOffset(text, codeStartOffset);
        } else {
          codeEndOffset = findBlockEndOffset(text, codeStartOffset);
        }

        matches.push({
          tagStartOffset,
          tagEndOffset,
          codeStartOffset,
          codeEndOffset,
          type
        });
      }
    }
  }

  return matches;
}

interface FileLevelResult {
  match: DiagnosticMatch;
  commentEndOffset: number;
}

/**
 * Checks if the file starts with a comment containing the tag.
 * If found and not in allowed states, returns a match that covers the entire file.
 * @ai-gen ok
 */
function checkFileLevelComment(
  text: string,
  tagRegex: RegExp,
  allowedStatesSet: Set<string>,
  rejectedStatesSet: Set<string>,
  detectInline: boolean,
  fileLevelPattern: RegExp,
  usesHashComments: boolean
): FileLevelResult | null {
  const fileLevelMatch = fileLevelPattern.exec(text);
  if (!fileLevelMatch) {
    return null;
  }

  const leadingWhitespace = fileLevelMatch[1];
  const fullComment = fileLevelMatch[2];

  // If it's an inline comment and detectInline is false, skip
  const isInlineComment = usesHashComments ? fullComment.startsWith('#') : fullComment.startsWith('//');
  if (isInlineComment && !detectInline) {
    return null;
  }

  // Check for tag inside the comment
  const tagMatch = tagRegex.exec(fullComment);
  if (!tagMatch) {
    return null;
  }

  const rawContent = tagMatch[1];
  // Clean trailing comment syntax: */ for JS, """ or ''' for Python
  const tagContent = rawContent
    .replace(/\s*\*\/$/, '')       // JS block comment end
    .replace(/\s*(?:"""|''')$/, '') // Python docstring end
    .trim()
    .toLowerCase();

  // If state is allowed, skip
  if (allowedStatesSet.has(tagContent)) {
    return null;
  }

  const type: 'warning' | 'rejected' = rejectedStatesSet.has(tagContent) ? 'rejected' : 'warning';

  const commentStartOffset = leadingWhitespace.length;
  const commentEndOffset = commentStartOffset + fullComment.length;
  const tagStartOffset = commentStartOffset + tagMatch.index;
  const tagEndOffset = tagStartOffset + tagMatch[0].length;

  return {
    match: {
      tagStartOffset,
      tagEndOffset,
      codeStartOffset: commentEndOffset,
      codeEndOffset: text.length, // Highlight entire file from after comment to end
      type,
      isFileLevel: true
    },
    commentEndOffset
  };
}

/**
 * Finds the end offset of a code block, properly handling braces inside strings,
 * template literals, and comments.
 *
 * Uses a hybrid approach for performance:
 * 1. Fast path: Quick scan for simple cases (no strings/comments between braces)
 * 2. Slow path: Careful character-by-character parsing when strings/comments detected
 *
 * @ai-gen ok
 */
function findBlockEndOffset(text: string, startOffset: number): number {
  const len = text.length;
  let i = startOffset;

  // Scan to find the opening brace of the function body.
  // Strategy: Find the FIRST { that appears AFTER we've closed all parentheses.
  // This handles: function foo(a = {}) { ... }
  // The { in "= {}" is inside parens (parenDepth > 0). The function body { comes after ).
  let parenDepth = 0;
  let maxParenDepth = 0;
  let lastSignificant = 0; // Track last significant char for regex detection

  while (i < len) {
    const char = text.charCodeAt(i);

    // Skip whitespace
    if (char === 32 || char === 9 || char === 10 || char === 13) {
      i++;
      continue;
    }

    // Check for regex literals in default parameter values
    // A regex can appear after = in a default parameter
    if (char === 47 && canStartRegex(lastSignificant)) { // '/'
      const next = text.charCodeAt(i + 1);
      if (next !== 47 && next !== 42) { // Not // or /*
        i = skipRegexLiteral(text, i, len);
        lastSignificant = 47;
        continue;
      }
    }

    // Skip strings to avoid false matches on () or {} inside strings
    if (char === 34 || char === 39 || char === 96) { // " ' `
      i = char === 96 ? skipTemplateLiteral(text, i, len) : skipString(text, i, char);
      lastSignificant = char;
      continue;
    }

    // Track parentheses
    if (char === 40) { // '('
      parenDepth++;
      if (parenDepth > maxParenDepth) {
        maxParenDepth = parenDepth;
      }
    } else if (char === 41) { // ')'
      parenDepth--;
    }
    // Found opening brace
    else if (char === 123) { // '{'
      // Accept { only if:
      // 1. We're outside all parentheses (parenDepth === 0)
      // 2. We've seen at least one ( before (maxParenDepth > 0) - meaning we passed function params
      //    OR we never saw any ( - meaning it's a class or object literal right after the comment
      if (parenDepth === 0) {
        break;
      }
    }
    // Semicolon means end of statement (type declaration, etc.)
    else if (char === 59 && parenDepth === 0) {
      return i + 1;
    }

    lastSignificant = char;
    i++;
  }

  // If no opening brace found, return end of text
  if (i >= len || text.charCodeAt(i) !== 123) {
    return len;
  }

  // i now points to the opening { of the function/block body
  const openingBraceOffset = i;

  // Fast path: Try simple brace counting first
  // Check if there are any string/comment characters in the remaining text
  // Use indexOf instead of regex+slice to avoid memory allocation
  const hasComplexContent = hasComplexContentInRange(text, openingBraceOffset + 1, len);

  if (!hasComplexContent) {
    // Fast path: No strings or comments, use simple brace counting
    // Start AFTER the opening brace with braceDepth = 1
    let braceDepth = 1;
    let j = openingBraceOffset + 1;
    while (j < len) {
      const char = text.charCodeAt(j);
      if (char === 123) {braceDepth++;}
      else if (char === 125) {
        braceDepth--;
        if (braceDepth === 0) {return j + 1;}
      }
      j++;
    }
    return len;
  }

  // Slow path: Careful parsing with string/comment handling
  return findBlockEndOffsetCareful(text, openingBraceOffset, len);
}

/**
 * Careful brace matching that properly handles strings, template literals, comments, and regex literals.
 * Called only when the fast path detects complex content.
 */
function findBlockEndOffsetCareful(text: string, startOffset: number, len: number): number {
  // startOffset points to the opening { of the block
  // Start with braceDepth = 1 and skip past the opening brace
  let i = startOffset + 1;
  let braceDepth = 1;
  // Track the last significant character for regex detection
  let lastSignificant = 123; // '{' - the opening brace

  while (i < len) {
    const char = text.charCodeAt(i);

    // Skip whitespace but don't update lastSignificant
    if (char === 32 || char === 9 || char === 10 || char === 13) {
      i++;
      continue;
    }

    // Skip single-line comments
    if (char === 47 && text.charCodeAt(i + 1) === 47) { // '//'
      i = text.indexOf('\n', i);
      if (i === -1) {return len;}
      i++;
      continue;
    }

    // Skip multi-line comments
    if (char === 47 && text.charCodeAt(i + 1) === 42) { // '/*'
      i = text.indexOf('*/', i + 2);
      if (i === -1) {return len;}
      i += 2;
      continue;
    }

    // Check for regex literals - / not followed by / or *
    // A regex can appear after: = ( [ , : ; ! & | ? { } return typeof void delete
    // It cannot appear after: ) ] identifier number string
    if (char === 47 && canStartRegex(lastSignificant)) { // '/'
      const next = text.charCodeAt(i + 1);
      if (next !== 47 && next !== 42) { // Not // or /*
        i = skipRegexLiteral(text, i, len);
        lastSignificant = 47; // After regex, division is possible
        continue;
      }
    }

    // Skip template literals (backticks) - handle nested ${}
    if (char === 96) { // '`'
      i = skipTemplateLiteral(text, i, len);
      lastSignificant = 96;
      continue;
    }

    // Skip double-quoted strings
    if (char === 34) { // '"'
      i = skipString(text, i, 34);
      lastSignificant = 34;
      continue;
    }

    // Skip single-quoted strings
    if (char === 39) { // "'"
      i = skipString(text, i, 39);
      lastSignificant = 39;
      continue;
    }

    // Handle braces
    if (char === 123) { // '{'
      braceDepth++;
    } else if (char === 125) { // '}'
      braceDepth--;
      if (braceDepth === 0) {
        return i + 1;
      }
    }

    lastSignificant = char;
    i++;
  }

  return len;
}

/**
 * Determines if a regex literal can start after the given character.
 * Based on JavaScript grammar rules.
 */
function canStartRegex(lastChar: number): boolean {
  // After these characters, / starts a regex:
  // = ( [ , : ; ! & | ? { } + - * % < > ~ ^
  // Also after keywords: return, typeof, void, delete, throw, new, in, of, case
  // For simplicity, we check common cases
  switch (lastChar) {
    case 61:  // '='
    case 40:  // '('
    case 91:  // '['
    case 44:  // ','
    case 58:  // ':'
    case 59:  // ';'
    case 33:  // '!'
    case 38:  // '&'
    case 124: // '|'
    case 63:  // '?'
    case 123: // '{'
    case 125: // '}'
    case 43:  // '+'
    case 45:  // '-'
    case 42:  // '*'
    case 37:  // '%'
    case 60:  // '<'
    case 62:  // '>'
    case 126: // '~'
    case 94:  // '^'
      return true;
    default:
      return false;
  }
}

/**
 * Skips a regex literal starting at position i, returns position after the regex.
 * Handles escape sequences inside the regex.
 */
function skipRegexLiteral(text: string, start: number, len: number): number {
  let i = start + 1; // Start after opening /
  while (i < len) {
    const c = text.charCodeAt(i);
    if (c === 92) { // '\' escape - skip next char
      i += 2;
      continue;
    }
    if (c === 91) { // '[' - character class, need to find ']'
      i++;
      while (i < len) {
        const cc = text.charCodeAt(i);
        if (cc === 92) { i += 2; continue; } // escape
        if (cc === 93) { i++; break; } // ']'
        i++;
      }
      continue;
    }
    if (c === 47) { // '/' - end of regex
      i++; // Move past the closing /
      // Skip flags (g, i, m, s, u, y, d)
      while (i < len) {
        const fc = text.charCodeAt(i);
        if ((fc >= 97 && fc <= 122) || (fc >= 65 && fc <= 90)) { // a-z, A-Z
          i++;
        } else {
          break;
        }
      }
      return i;
    }
    if (c === 10 || c === 13) { // newline - invalid regex, bail out
      return start + 1; // Return early, let normal parsing handle it
    }
    i++;
  }
  return len;
}

/**
 * Skips a template literal, handling nested ${} expressions.
 */
function skipTemplateLiteral(text: string, start: number, len: number): number {
  let i = start + 1;
  while (i < len) {
    const c = text.charCodeAt(i);
    if (c === 92) { // '\' escape
      i += 2;
      continue;
    }
    if (c === 96) { // closing '`'
      return i + 1;
    }
    if (c === 36 && text.charCodeAt(i + 1) === 123) { // '${'
      // Skip the ${...} expression
      i += 2;
      let templateBraceDepth = 1;
      while (i < len && templateBraceDepth > 0) {
        const tc = text.charCodeAt(i);
        if (tc === 123) {templateBraceDepth++;}
        else if (tc === 125) {templateBraceDepth--;}
        else if (tc === 92) { i++; } // skip escape
        else if (tc === 34 || tc === 39) {
          i = skipString(text, i, tc);
          continue;
        } else if (tc === 96) {
          // Nested template literal
          i = skipTemplateLiteral(text, i, len);
          continue;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return len;
}

/**
 * Skips a string literal starting at position i, returns position after closing quote.
 */
function skipString(text: string, start: number, quoteChar: number): number {
  let i = start + 1;
  const len = text.length;
  while (i < len) {
    const c = text.charCodeAt(i);
    if (c === 92) { // '\' escape - skip next char
      i += 2;
      continue;
    }
    if (c === quoteChar) {
      return i + 1;
    }
    i++;
  }
  return len;
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\\]/g, '\\$&');
}

/**
 * Checks if the text range contains characters that require careful parsing.
 * Uses charCodeAt instead of slice+regex to avoid memory allocation.
 */
function hasComplexContentInRange(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    // Check for: " (34), ' (39), ` (96), / (47)
    if (c === 34 || c === 39 || c === 96) {
      return true;
    }
    // Check for // or /* (/ followed by / or *)
    if (c === 47 && i + 1 < end) {
      const next = text.charCodeAt(i + 1);
      if (next === 47 || next === 42) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Finds the end offset of a Python code block using indentation-based scoping.
 * Python uses indentation to define blocks. For a function like:
 *   def foo():
 *       body
 * The block includes all lines indented MORE than the def line.
 */
function findPythonBlockEndOffset(text: string, startOffset: number): number {
  const len = text.length;

  // Find the start of the line containing startOffset to get the def/class line indentation
  let lineStart = startOffset;
  while (lineStart > 0 && text.charCodeAt(lineStart - 1) !== 10) {
    lineStart--;
  }

  // Get indentation of the def/class line (the declaration line)
  let defIndent = 0;
  let i = lineStart;
  while (i < len) {
    const c = text.charCodeAt(i);
    if (c === 32) { defIndent++; i++; } // space
    else if (c === 9) { defIndent += 4; i++; } // tab (count as 4 spaces)
    else { break; }
  }

  // Find the end of the first line (the def/class line) to start scanning from there
  let pos = startOffset;
  while (pos < len && text.charCodeAt(pos) !== 10) {
    pos++;
  }
  let lastContentEnd = pos; // Track the end of the last content line (for return value)
  if (pos < len) { pos++; } // Skip the newline

  // Scan subsequent lines - the block includes all lines indented MORE than defIndent
  while (pos < len) {
    let lineIndent = 0;
    let linePos = pos;

    // Calculate indentation
    while (linePos < len) {
      const c = text.charCodeAt(linePos);
      if (c === 32) { lineIndent++; linePos++; }
      else if (c === 9) { lineIndent += 4; linePos++; }
      else { break; }
    }

    // Check if line is empty or only whitespace - these don't break the block
    if (linePos >= len || text.charCodeAt(linePos) === 10) {
      pos = linePos + 1;
      continue;
    }

    // Check if it's a comment line - include it if indented, skip otherwise
    if (text.charCodeAt(linePos) === 35) { // '#'
      if (lineIndent > defIndent) {
        // Indented comment is part of the block
        while (linePos < len && text.charCodeAt(linePos) !== 10) {
          linePos++;
        }
        lastContentEnd = linePos;
      }
      pos = linePos + 1;
      continue;
    }

    // If indentation is <= def line, we've exited the block
    if (lineIndent <= defIndent) {
      return lastContentEnd;
    }

    // This line is part of the block - find its end
    while (linePos < len && text.charCodeAt(linePos) !== 10) {
      linePos++;
    }
    lastContentEnd = linePos;
    pos = linePos + 1;
  }

  return len;
}
