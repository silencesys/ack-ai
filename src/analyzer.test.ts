import { describe, it, expect } from 'vitest';
import { findAiGenDiagnostics } from './analyzer';

describe('AI Gen Analyzer', () => {
  it('should detect @ai-gen tag without "ok"', () => {
    const code = `
/**
 * Some comment
 * @ai-gen
 */
function test() {
  console.log('hello');
}
`;
    const matches = findAiGenDiagnostics(code);
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe('warning');
    
    const tagIndex = code.indexOf('@ai-gen');
    expect(matches[0].tagStartOffset).toBeGreaterThanOrEqual(tagIndex);
  });

  it('should ignore @ai-gen tag with "ok"', () => {
    const code = `
/**
 * @ai-gen ok
 */
const x = 1;
`;
    const matches = findAiGenDiagnostics(code);
    expect(matches).toHaveLength(0);
  });

  it('should detect @ai-gen with other text', () => {
    const code = `
/**
 * @ai-gen pending review
 */
class A {}
`;
    const matches = findAiGenDiagnostics(code);
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe('warning');
  });

  it('should calculate code range for single line statement', () => {
    const code = `
/**
 * @ai-gen
 */
const x = 5;
`;
    const matches = findAiGenDiagnostics(code);
    expect(matches).toHaveLength(1);
    
    const codeStart = code.indexOf('const x = 5;');
    const codeEnd = codeStart + 'const x = 5;'.length;
    
    expect(matches[0].codeStartOffset).toBe(codeStart);
    expect(matches[0].codeEndOffset).toBe(codeEnd);
  });

  it('should calculate code range correctly for function block (DocBlock)', () => {
    const code = `
/**
 * @ai-gen
 */

function target() {
  return true;
}
`;
    const matches = findAiGenDiagnostics(code);
    expect(matches).toHaveLength(1);
    
    const codeStart = code.indexOf('function target() {');
    const codeEnd = code.indexOf('}') + 1; // Include closing brace
    
    expect(matches[0].codeStartOffset).toBe(codeStart);
    expect(matches[0].codeEndOffset).toBe(codeEnd);
  });

  it('should handle nested braces correctly', () => {
    const code = `
/** @ai-gen */
function complex() {
  if (true) {
    return { a: 1 };
  }
}
`;
    const matches = findAiGenDiagnostics(code);
    expect(matches).toHaveLength(1);
    
    const codeEnd = code.lastIndexOf('}') + 1;
    expect(matches[0].codeEndOffset).toBe(codeEnd);
  });

  it('should detect inline comments when enabled', () => {
    const code = `
// @ai-gen
const y = 10;
`;
    const matches = findAiGenDiagnostics(code, { detectInline: true });
    expect(matches).toHaveLength(1);
    
    const codeStart = code.indexOf('const y = 10;');
    expect(matches[0].codeStartOffset).toBe(codeStart);
  });

  it('should ignore inline comments when disabled', () => {
    const code = `
// @ai-gen
const y = 10;
`;
    const matches = findAiGenDiagnostics(code, { detectInline: false });
    expect(matches).toHaveLength(0);
  });

  it('should ONLY highlight next line for inline comments (not full block)', () => {
    const code = `
// @ai-gen
if (true) {
  doSomething();
}
`;
    const matches = findAiGenDiagnostics(code, { detectInline: true });
    expect(matches).toHaveLength(1);

    const codeStart = code.indexOf('if (true) {');
    const nextNewline = code.indexOf('\n', codeStart);
    
    expect(matches[0].codeStartOffset).toBe(codeStart);
    expect(matches[0].codeEndOffset).toBe(nextNewline);
  });

  it('should detect custom tags', () => {
    const code = `
/**
 * @custom-tag
 */
function test() {}
`;
    const matches = findAiGenDiagnostics(code, { tag: '@custom-tag' });
    expect(matches).toHaveLength(1);
  });

  it('should ignore default tag if custom tag is set', () => {
    const code = `
/**
 * @ai-gen
 */
function test() {}
`;
    const matches = findAiGenDiagnostics(code, { tag: '@custom-tag' });
    expect(matches).toHaveLength(0);
  });

  it('should support multiple allowed states (case insensitive)', () => {
    const code = `
/** @ai-gen reviewed */
const a = 1;

/** @ai-gen PASSING */
const b = 2;

/** @ai-gen rejected */
const c = 3;
`;
    const matches = findAiGenDiagnostics(code, { 
      allowedStates: ['reviewed', 'passing'] 
    });
    
    // Should match ONLY the 'rejected' one
    expect(matches).toHaveLength(1);
    // Find roughly where 'rejected' is
    const rejectedIndex = code.indexOf('@ai-gen rejected');
    expect(matches[0].tagStartOffset).toBeGreaterThanOrEqual(rejectedIndex);
  });

  it('should classify rejected states as "rejected"', () => {
    const code = `
/** @ai-gen rejected */
const a = 1;

/** @ai-gen */
const b = 2;
`;
    const matches = findAiGenDiagnostics(code,{
      rejectedStates: ['rejected']
    });

    expect(matches).toHaveLength(2);
    
    const rejectedMatch = matches.find(m => m.type === 'rejected');
    const warningMatch = matches.find(m => m.type === 'warning');
    
    expect(rejectedMatch).toBeDefined();
    expect(warningMatch).toBeDefined();
    expect(rejectedMatch?.tagStartOffset).toBeLessThan(warningMatch?.tagStartOffset!);
  });
});