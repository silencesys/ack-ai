export interface DiagnosticMatch {
  tagStartOffset: number;
  tagEndOffset: number;
  codeStartOffset: number;
  codeEndOffset: number;
  type: 'warning' | 'rejected';
}

export interface AnalyzerOptions {
  detectInline: boolean;
  tag: string;
  allowedStates: string[];
  rejectedStates: string[];
}

// Reusable regex patterns for performance (stateless)
const DOC_BLOCK_PATTERN = /(\/\*\*[\s\S]*?\*\/)/g;
const ALL_COMMENTS_PATTERN = /(\/\*\*[\s\S]*?\*\/|\/\/.*)/g;
const NON_WHITESPACE_PATTERN = /\S/g;
const BRACE_PATTERN = /[{}]/g;

/**
 * Analyzes text to find specific tags (default @ai-gen) that are not marked as 'ok'.
 * Returns the character offsets needed to create VS Code diagnostics.
 * Uses optimized Regex scanning (O(N)) to minimize main-thread blocking.
 */
export function findAiGenDiagnostics(text: string, options: Partial<AnalyzerOptions> = {}): DiagnosticMatch[] {
  const { 
    detectInline = true, 
    tag = '@ai-gen', 
    allowedStates = ['ok'],
    rejectedStates = ['rejected', 'reject']
  } = options;
  
  const matches: DiagnosticMatch[] = [];
  
  // Normalize allowed states to lowercase for case-insensitive comparison
  // Set lookup is O(1) vs Array includes O(N) - faster for many allowed states
  const allowedStatesSet = new Set(allowedStates.map(s => s.toLowerCase()));
  const rejectedStatesSet = new Set(rejectedStates.map(s => s.toLowerCase()));
  
  // Select the appropriate pattern
  // We reset lastIndex to ensure clean run if we were to reuse global instances (safeguard)
  const mainPattern = detectInline ? ALL_COMMENTS_PATTERN : DOC_BLOCK_PATTERN;
  mainPattern.lastIndex = 0;

  // Compile tag regex once per call
  const escapedTag = escapeRegExp(tag);
  const tagRegex = new RegExp(`${escapedTag}\\s*(.*)`, 'i');

  let match;
  while ((match = mainPattern.exec(text)) !== null) {
    const fullComment = match[0];
    const commentStartOffset = match.index;
    const commentEndOffset = commentStartOffset + fullComment.length;
    
    // Check for tag inside the comment
    const tagMatch = tagRegex.exec(fullComment);

    if (tagMatch) {
      // Fast path: Clean and check state
      const rawContent = tagMatch[1];
      // Optimization: Only run replace/trim if strictly necessary
      // But we need to remove trailing '*/' for docblocks.
      const tagContent = rawContent.replace(/\s*\*\/$/, '').trim().toLowerCase();

      // Check for Allowed State
      if (allowedStatesSet.has(tagContent)) {
        continue;
      }

      // Determine Type (Rejected vs Warning)
      const type: 'warning' | 'rejected' = rejectedStatesSet.has(tagContent) ? 'rejected' : 'warning';

      // 1. Calculate Tag Location
      const tagStartOffset = commentStartOffset + tagMatch.index;
      const tagEndOffset = tagStartOffset + tagMatch[0].length;

      // 2. Calculate Code Block Location
      // Optimization: Use Regex to jump to next non-whitespace instead of loop
      NON_WHITESPACE_PATTERN.lastIndex = commentEndOffset;
      const codeMatch = NON_WHITESPACE_PATTERN.exec(text);
      
      if (codeMatch) {
        const codeStartOffset = codeMatch.index;
        let codeEndOffset: number;

        // Special handling for inline comments: Highlight ONLY the next line
        // We check start of fullComment. 'match[0]' is already the full match.
        if (fullComment.startsWith('//')) {
          const nextNewline = text.indexOf('\n', codeStartOffset);
          codeEndOffset = nextNewline !== -1 ? nextNewline : text.length;
        } else {
          // Standard DocBlock: Use smart block detection
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

function findBlockEndOffset(text: string, startOffset: number): number {
  // 1. Heuristic: Check for single-line statement (ends with ';')
  // We scan manually here because it's usually very short (immediate next few chars).
  // Using Regex overhead might be higher for looking at 10-20 chars.
  const len = text.length;
  let j = startOffset;
  
  while (j < len) {
      const char = text.charCodeAt(j);
      // 59 = ';', 123 = '{', 10 = '\n'
      if (char === 123) { // '{'
          break; // Found block start
      }
      if (char === 59) { // ';'
          return j + 1; // Found statement end
      }
      if (char === 10) { // '\n'
          // Newline before brace or semicolon. 
          // Stop heuristic, assume block logic needed.
          break;
      }
      j++;
  }

  // 2. Brace Counting using Regex Jump
  // This is much faster for large blocks as it skips all non-brace characters via C++ engine.
  BRACE_PATTERN.lastIndex = startOffset;
  
  let braceDepth = 0;
  let foundFirstBrace = false;
  let match;

  while ((match = BRACE_PATTERN.exec(text)) !== null) {
      if (match[0] === '{') {
          braceDepth++;
          foundFirstBrace = true;
      } else {
          braceDepth--;
          if (foundFirstBrace && braceDepth === 0) {
              return match.index + 1;
          }
      }
  }

  return len;
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\\]/g, '\\$&');
}