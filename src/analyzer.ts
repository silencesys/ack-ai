export interface DiagnosticMatch {
  tagStartOffset: number;
  tagEndOffset: number;
  codeStartOffset: number;
  codeEndOffset: number;
  type: 'warning' | 'rejected';
  isFileLevel?: boolean; // When true, the entire file should be highlighted
}

export interface AnalyzerOptions {
  detectInline: boolean;
  detectFileLevel: boolean;
  tag: string;
  allowedStates: string[];
  rejectedStates: string[];
}

// Reusable regex patterns for performance (stateless)
const DOC_BLOCK_PATTERN = /(\/\*\*[\s\S]*?\*\/)/g;
const ALL_COMMENTS_PATTERN = /(\/\*\*[\s\S]*?\*\/|\/\/.*)/g;
const NON_WHITESPACE_PATTERN = /\S/g;
// Pattern to detect file-level comments at the start of the file (allowing only whitespace before)
const FILE_LEVEL_COMMENT_PATTERN = /^(\s*)(\/\*\*[\s\S]*?\*\/|\/\/.*)/;

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
    rejectedStates = ['rejected', 'reject']
  } = options;

  const matches: DiagnosticMatch[] = [];

  const allowedStatesSet = new Set(allowedStates.map(s => s.toLowerCase()));
  const rejectedStatesSet = new Set(rejectedStates.map(s => s.toLowerCase()));

  const escapedTag = escapeRegExp(tag);
  const tagRegex = new RegExp(`${escapedTag}\\s*(.*)`, 'i');

  // Check for file-level comment first (comment at the very start of the file)
  let fileLevelCommentEndOffset = -1;
  if (detectFileLevel) {
    const fileLevelResult = checkFileLevelComment(text, tagRegex, allowedStatesSet, rejectedStatesSet, detectInline);
    if (fileLevelResult) {
      matches.push(fileLevelResult.match);
      fileLevelCommentEndOffset = fileLevelResult.commentEndOffset;
    }
  }

  const mainPattern = detectInline ? ALL_COMMENTS_PATTERN : DOC_BLOCK_PATTERN;
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
      const tagContent = rawContent.replace(/\s*\*\/$/, '').trim().toLowerCase();

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

        if (fullComment.startsWith('//')) {
          const nextNewline = text.indexOf('\n', codeStartOffset);
          codeEndOffset = nextNewline !== -1 ? nextNewline : text.length;
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
 */
function checkFileLevelComment(
  text: string,
  tagRegex: RegExp,
  allowedStatesSet: Set<string>,
  rejectedStatesSet: Set<string>,
  detectInline: boolean
): FileLevelResult | null {
  const fileLevelMatch = FILE_LEVEL_COMMENT_PATTERN.exec(text);
  if (!fileLevelMatch) {
    return null;
  }

  const leadingWhitespace = fileLevelMatch[1];
  const fullComment = fileLevelMatch[2];

  // If it's an inline comment and detectInline is false, skip
  if (fullComment.startsWith('//') && !detectInline) {
    return null;
  }

  // Check for tag inside the comment
  const tagMatch = tagRegex.exec(fullComment);
  if (!tagMatch) {
    return null;
  }

  const rawContent = tagMatch[1];
  const tagContent = rawContent.replace(/\s*\*\/$/, '').trim().toLowerCase();

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

  // Fast heuristic scan to find first significant character
  while (i < len) {
    const char = text.charCodeAt(i);
    if (char === 123) { // '{'
      break;
    }
    if (char === 59) { // ';'
      return i + 1;
    }
    if (char === 10) { // '\n'
      break;
    }
    i++;
  }

  // If no opening brace found, return end of text
  if (i >= len || text.charCodeAt(i) !== 123) {
    return len;
  }

  // Fast path: Try simple brace counting first
  // Check if there are any string/comment characters in the remaining text
  const searchRegion = text.slice(i);
  const hasComplexContent = /["'`]|\/[/*]/.test(searchRegion);

  if (!hasComplexContent) {
    // Fast path: No strings or comments, use simple brace counting
    let braceDepth = 0;
    while (i < len) {
      const char = text.charCodeAt(i);
      if (char === 123) {braceDepth++;}
      else if (char === 125) {
        braceDepth--;
        if (braceDepth === 0) {return i + 1;}
      }
      i++;
    }
    return len;
  }

  // Slow path: Careful parsing with string/comment handling
  return findBlockEndOffsetCareful(text, startOffset, len);
}

/**
 * Careful brace matching that properly handles strings, template literals, and comments.
 * Called only when the fast path detects complex content.
 */
function findBlockEndOffsetCareful(text: string, startOffset: number, len: number): number {
  let i = startOffset;
  let braceDepth = 0;
  let foundFirstBrace = false;

  while (i < len) {
    const char = text.charCodeAt(i);

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

    // Skip template literals (backticks) - handle nested ${}
    if (char === 96) { // '`'
      i = skipTemplateLiteral(text, i, len);
      continue;
    }

    // Skip double-quoted strings
    if (char === 34) { // '"'
      i = skipString(text, i, 34);
      continue;
    }

    // Skip single-quoted strings
    if (char === 39) { // "'"
      i = skipString(text, i, 39);
      continue;
    }

    // Handle braces
    if (char === 123) { // '{'
      braceDepth++;
      foundFirstBrace = true;
    } else if (char === 125) { // '}'
      braceDepth--;
      if (foundFirstBrace && braceDepth === 0) {
        return i + 1;
      }
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
