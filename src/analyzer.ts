export interface DiagnosticMatch {
  tagStartOffset: number;
  tagEndOffset: number;
  codeStartOffset: number;
  codeEndOffset: number;
}

export interface AnalyzerOptions {
  detectInline: boolean;
  tag: string;
  allowedStates: string[];
}

/**
 * Analyzes text to find specific tags (default @ai-gen) that are not marked as 'ok'.
 * Returns the character offsets needed to create VS Code diagnostics.
 * Uses index arithmetic to avoid expensive string splitting.
 */
export function findAiGenDiagnostics(text: string, options: Partial<AnalyzerOptions> = {}): DiagnosticMatch[] {
  const { 
    detectInline = true, 
    tag = '@ai-gen', 
    allowedStates = ['ok'] 
  } = options;
  
  const matches: DiagnosticMatch[] = [];
  
  // Normalize allowed states to lowercase for case-insensitive comparison
  const normalizedAllowedStates = allowedStates.map(s => s.toLowerCase());
  
  // Match DocBlocks OR Inline comments (if enabled)
  const pattern = detectInline 
    ? /(\/\*\*[\s\S]*?\*\/|\/\/.*)/g 
    : /(\/\*\*[\s\S]*?\*\/)/g;

  // Create dynamic regex for the tag
  const escapedTag = escapeRegExp(tag);
  const tagRegex = new RegExp(`${escapedTag}\\s*(.*)`, 'i');

  let match;

  while ((match = pattern.exec(text)) !== null) {
    const fullComment = match[0];
    const commentStartOffset = match.index;
    const commentEndOffset = commentStartOffset + fullComment.length;
    
    // Check for tag inside the comment
    const tagMatch = tagRegex.exec(fullComment);

    if (tagMatch) {
      const tagContent = tagMatch[1].replace(/\s*\*\/$/, '').trim();

      // Case C: Explicitly marked as safe (checked against allowed list)
      if (normalizedAllowedStates.includes(tagContent.toLowerCase())) {
        continue;
      }

      // 1. Calculate Tag Location
      const tagStartOffset = commentStartOffset + tagMatch.index;
      const tagEndOffset = tagStartOffset + tagMatch[0].length;

      // 2. Calculate Code Block Location
      // Search for first non-whitespace char after comment
      let codeStartOffset = -1;
      let i = commentEndOffset;
      
      while (i < text.length) {
        if (!/\s/.test(text[i])) {
          codeStartOffset = i;
          break;
        }
        i++;
      }

      if (codeStartOffset !== -1) {
        let codeEndOffset: number;

        // Special handling for inline comments: Highlight ONLY the next line
        if (fullComment.trim().startsWith('//')) {
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
          codeEndOffset
        });
      }
    }
  }

  return matches;
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findBlockEndOffset(text: string, startOffset: number): number {
  let braceDepth = 0;
  let foundFirstBrace = false;
  
  // Check if it's a single line statement (ends in semicolon before any brace)
  // Scan forward until newline, brace, or semicolon
  let j = startOffset;
  
  // Heuristic: Check the "statement" nature before entering the main loop
  // If we hit a ';' before a '{' or '\n', it's likely a statement.
  while (j < text.length) {
      const char = text[j];
      if (char === '{') {
          break;
      }
      if (char === ';') {
          // Found semicolon before brace. It's a statement.
          // Return index of semicolon + 1 (to include it)
          return j + 1;
      }
      if (char === '\n') {
          // Newline before brace or semicolon. 
          // It might be a multiline statement or a block starts on next line.
          // Let's drop into the brace counting mode.
          break;
      }
      j++;
  }

  // Brace counting mode
  for (let i = startOffset; i < text.length; i++) {
    const char = text[i];
    
    if (char === '{') {
      braceDepth++;
      foundFirstBrace = true;
    } else if (char === '}') {
      braceDepth--;
      if (foundFirstBrace && braceDepth === 0) {
        return i + 1; // Include the closing brace
      }
    }
    
    // Safety break: If we are extremely far (e.g. 5000 chars) and haven't found a brace
    // and we aren't inside one, maybe stop? 
    // For now, relying on EOF is safe enough for modern machines, 
    // but strict depth checks could be added.
  }

  // Fallback: end of file
  return text.length;
}