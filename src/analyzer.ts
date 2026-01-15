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

// Time-slicing configuration
const YIELD_INTERVAL_MS = 15; // Yield every 15ms to keep UI responsive

/**
 * Analyzes text to find specific tags (default @ai-gen) that are not marked as 'ok'.
 * Returns the character offsets needed to create VS Code diagnostics.
 * Uses optimized Regex scanning (O(N)) AND time-slicing to prevent main-thread blocking.
 */
export async function findAiGenDiagnostics(text: string, options: Partial<AnalyzerOptions> = {}, token?: { isCancellationRequested: boolean }): Promise<DiagnosticMatch[]> {
  const { 
    detectInline = true, 
    tag = '@ai-gen', 
    allowedStates = ['ok'],
    rejectedStates = ['rejected', 'reject']
  } = options;
  
  const matches: DiagnosticMatch[] = [];
  
  const allowedStatesSet = new Set(allowedStates.map(s => s.toLowerCase()));
  const rejectedStatesSet = new Set(rejectedStates.map(s => s.toLowerCase()));
  
  const mainPattern = detectInline ? ALL_COMMENTS_PATTERN : DOC_BLOCK_PATTERN;
  mainPattern.lastIndex = 0;

  const escapedTag = escapeRegExp(tag);
  const tagRegex = new RegExp(`${escapedTag}\s*(.*)`, 'i');

  let startTime = Date.now();
  let match;
  
  while ((match = mainPattern.exec(text)) !== null) {
    // Cancellation check
    if (token?.isCancellationRequested) {
      return [];
    }

    // Time-slicing check
    if (Date.now() - startTime > YIELD_INTERVAL_MS) {
      await new Promise(resolve => setTimeout(resolve, 0)); // Yield to event loop
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

function findBlockEndOffset(text: string, startOffset: number): number {
  const len = text.length;
  let j = startOffset;
  
  // Fast heuristic scan
  while (j < len) {
      const char = text.charCodeAt(j);
      if (char === 123) { // '{'
          break; 
      }
      if (char === 59) { // ';'
          return j + 1; 
      }
      if (char === 10) { // '\n'
          break;
      }
      j++;
  }

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
