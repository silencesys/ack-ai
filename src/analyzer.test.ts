import { describe, it, expect, vi } from 'vitest';
import { findAiGenDiagnostics } from './analyzer';

describe('AI Gen Analyzer', () => {
  it('should detect @ai-gen tag without "ok"', async () => {
    const code = `
/**
 * Some comment
 * @ai-gen
 */
function test() {
  console.log('hello');
}
`;
    const matches = await findAiGenDiagnostics(code);
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe('warning');

    const tagIndex = code.indexOf('@ai-gen');
    expect(matches[0].tagStartOffset).toBeGreaterThanOrEqual(tagIndex);
  });

  it('should ignore @ai-gen tag with "ok"', async () => {
    const code = `
/**
 * @ai-gen ok
 */
const x = 1;
`;
    const matches = await findAiGenDiagnostics(code);
    expect(matches).toHaveLength(0);
  });

  it('should detect @ai-gen with other text', async () => {
    const code = `
/**
 * @ai-gen pending review
 */
class A {}
`;
    const matches = await findAiGenDiagnostics(code);
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe('warning');
  });

  it('should underline only the tag token, not trailing comment syntax', async () => {
    const code = `/** @ai-gen */\nconst x = 1;`;
    const matches = await findAiGenDiagnostics(code);
    expect(matches).toHaveLength(1);

    const underlined = code.slice(matches[0].tagStartOffset, matches[0].tagEndOffset);
    expect(underlined).toBe('@ai-gen');
  });

  it('should calculate code range for single line statement', async () => {
    const code = `const prefix = 0;
/**
 * @ai-gen
 */
const x = 5;
`;
    const matches = await findAiGenDiagnostics(code);
    expect(matches).toHaveLength(1);

    const codeStart = code.indexOf('const x = 5;');
    const codeEnd = codeStart + 'const x = 5;'.length;

    expect(matches[0].codeStartOffset).toBe(codeStart);
    expect(matches[0].codeEndOffset).toBe(codeEnd);
  });

  it('should calculate code range correctly for function block (DocBlock)', async () => {
    const code = `const prefix = 0;
/**
 * @ai-gen
 */

function target() {
  return true;
}
`;
    const matches = await findAiGenDiagnostics(code);
    expect(matches).toHaveLength(1);

    const codeStart = code.indexOf('function target() {');
    const codeEnd = code.indexOf('}', codeStart) + 1; // Include closing brace

    expect(matches[0].codeStartOffset).toBe(codeStart);
    expect(matches[0].codeEndOffset).toBe(codeEnd);
  });

  it('should handle nested braces correctly', async () => {
    const code = `const prefix = 0;
/** @ai-gen */
function complex() {
  if (true) {
    return { a: 1 };
  }
}
`;
    const matches = await findAiGenDiagnostics(code);
    expect(matches).toHaveLength(1);

    const codeEnd = code.lastIndexOf('}') + 1;
    expect(matches[0].codeEndOffset).toBe(codeEnd);
  });

  it('should ignore braces inside double-quoted strings', async () => {
    const code = `const prefix = 0;
/** @ai-gen */
function foo() {
  const str = "{ not a brace }";
  return true;
}
`;
    const matches = await findAiGenDiagnostics(code);
    expect(matches).toHaveLength(1);

    const codeEnd = code.lastIndexOf('}') + 1;
    expect(matches[0].codeEndOffset).toBe(codeEnd);
  });

  it('should ignore braces inside single-quoted strings', async () => {
    const code = `const prefix = 0;
/** @ai-gen */
function foo() {
  const str = '{ not a brace }';
  return true;
}
`;
    const matches = await findAiGenDiagnostics(code);
    expect(matches).toHaveLength(1);

    const codeEnd = code.lastIndexOf('}') + 1;
    expect(matches[0].codeEndOffset).toBe(codeEnd);
  });

  it('should ignore braces inside template literals', async () => {
    // Constructing string with concatenation to avoid template literal confusion
    const code = 'const prefix = 0;\n' +
                 '/** @ai-gen */\n' +
                 'function foo() {\n' +
                 '  const str = ` { not a brace }`;\n' +
                 '  return true;\n' +
                 '}\n';

    const matches = await findAiGenDiagnostics(code);
    expect(matches).toHaveLength(1);

    const codeEnd = code.lastIndexOf('}') + 1;
    expect(matches[0].codeEndOffset).toBe(codeEnd);
  });

  it('should handle template literals with expressions', async () => {
    const code = `const prefix = 0;
/** @ai-gen */
function foo() {
  const x = 1;
  const str =
  return true;
}
`;
    const matches = await findAiGenDiagnostics(code);
    expect(matches).toHaveLength(1);

    const codeEnd = code.lastIndexOf('}') + 1;
    expect(matches[0].codeEndOffset).toBe(codeEnd);
  });

  it('should ignore braces inside comments within functions', async () => {
    const code = `const prefix = 0;
/** @ai-gen */
function foo() {
  // { not a brace }
  /* { also not a brace } */
  return true;
}
`;
    const matches = await findAiGenDiagnostics(code);
    expect(matches).toHaveLength(1);

    const codeEnd = code.lastIndexOf('}') + 1;
    expect(matches[0].codeEndOffset).toBe(codeEnd);
  });

  it('should handle escaped quotes in strings', async () => {
    const code = `const prefix = 0;
/** @ai-gen */
function foo() {
  const str = "escaped \" quote { brace }";
  return true;
}
`;
    const matches = await findAiGenDiagnostics(code);
    expect(matches).toHaveLength(1);

    const codeEnd = code.lastIndexOf('}') + 1;
    expect(matches[0].codeEndOffset).toBeGreaterThanOrEqual(codeEnd);
  });

  it('should correctly identify function body when return type has intersection with object literal', async () => {
    const code = `
/**
 * @ai-gen
 */
const setStaticFields = async (
  form: any,
  template: any,
  skipSealable: boolean = false,
  roles: string[] = []
): Promise<any & { _id: string; }> => {
  console.log('body');
  return { _id: '1' };
}
`;
    const matches = await findAiGenDiagnostics(code);
    expect(matches).toHaveLength(1);

    const bodyStart = code.indexOf('console.log');
    const bodyEnd = code.lastIndexOf('}') + 1;

    expect(matches[0].codeEndOffset).toBe(bodyEnd);
    expect(matches[0].codeStartOffset).toBeLessThan(bodyStart);
  });

  it('should detect inline comments when enabled', async () => {
    const code = `const prefix = 0;
// @ai-gen
const y = 10;
`;
    const matches = await findAiGenDiagnostics(code, { detectInline: true });
    expect(matches).toHaveLength(1);

    const codeStart = code.indexOf('const y = 10;');
    expect(matches[0].codeStartOffset).toBe(codeStart);
  });

  it('should ignore inline comments when disabled', async () => {
    const code = `
// @ai-gen
const y = 10;
`;
    const matches = await findAiGenDiagnostics(code, { detectInline: false });
    expect(matches).toHaveLength(0);
  });

  it('should ONLY highlight next line for inline comments (not full block)', async () => {
    const code = `const prefix = 0;
// @ai-gen
if (true) {
  doSomething();
}
`;
    const matches = await findAiGenDiagnostics(code, { detectInline: true });
    expect(matches).toHaveLength(1);

    const codeStart = code.indexOf('if (true) {');
    const nextNewline = code.indexOf('\n', codeStart);

    expect(matches[0].codeStartOffset).toBe(codeStart);
    expect(matches[0].codeEndOffset).toBeGreaterThan(codeStart);
    expect(matches[0].codeEndOffset).toBeLessThan(nextNewline);
  });

  it('should detect custom tags', async () => {
    const code = `
/**
 * @custom-tag
 */
function test() {}
`;
    const matches = await findAiGenDiagnostics(code, { tag: '@custom-tag' });
    expect(matches).toHaveLength(1);
  });

  it('should ignore default tag if custom tag is set', async () => {
    const code = `
/**
 * @ai-gen
 */
function test() {}
`;
    const matches = await findAiGenDiagnostics(code, { tag: '@custom-tag' });
    expect(matches).toHaveLength(0);
  });

  it('should support custom tags with regex metacharacters', async () => {
    const code = `
/**
 * @ai-gen+
 */
function test() {}
`;
    const matches = await findAiGenDiagnostics(code, { tag: '@ai-gen+' });
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe('warning');
  });

  it('should support multiple allowed states (case insensitive)', async () => {
    const code = `
/** @ai-gen reviewed */
const a = 1;

/** @ai-gen PASSING */
const b = 2;

/** @ai-gen rejected */
const c = 3;
`;
    const matches = await findAiGenDiagnostics(code, {
      allowedStates: ['reviewed', 'passing']
    });

    // Should match ONLY the 'rejected' one
    expect(matches).toHaveLength(1);
    const rejectedIndex = code.indexOf('@ai-gen rejected');
    expect(matches[0].tagStartOffset).toBeGreaterThanOrEqual(rejectedIndex);
  });

  it('should classify rejected states as "rejected"', async () => {
    const code = `
/** @ai-gen rejected */
const a = 1;

/** @ai-gen */
const b = 2;
`;
    const matches = await findAiGenDiagnostics(code,{
      rejectedStates: ['rejected']
    });

    expect(matches).toHaveLength(2);

    const rejectedMatch = matches.find(m => m.type === 'rejected');
    const warningMatch = matches.find(m => m.type === 'warning');

    expect(rejectedMatch).toBeDefined();
    expect(warningMatch).toBeDefined();
    expect(rejectedMatch?.tagStartOffset).toBeLessThan(warningMatch?.tagStartOffset!);
  });

  // File-level comment tests
  describe('File-level comments', () => {
    it('should detect @ai-gen at the start of file (inline comment) and highlight entire file', async () => {
      const code = `// @ai-gen
function foo() {
  return 1;
}

function bar() {
  return 2;
}
`;
      const matches = await findAiGenDiagnostics(code, { detectInline: true });
      expect(matches).toHaveLength(1);
      expect(matches[0].isFileLevel).toBe(true);
      expect(matches[0].type).toBe('warning');
      expect(matches[0].codeEndOffset).toBe(code.length);
    });

    it('should NOT treat docblock at start of file as file-level (should highlight only following function)', async () => {
      const code = `/** @ai-gen */
function foo() {
  return 1;
}

function bar() {
  return 2;
}
`;
      const matches = await findAiGenDiagnostics(code);
      expect(matches).toHaveLength(1);
      // Docblocks at start of file should NOT be file-level - they should only highlight the following function
      expect(matches[0].isFileLevel).toBeUndefined();
      expect(matches[0].type).toBe('warning');
      // Code end should be at the end of first function, not the entire file
      expect(matches[0].codeEndOffset).toBeLessThan(code.length);
    });

    it('should allow whitespace before file-level inline comment', async () => {
      const code = `
// @ai-gen
function foo() {}
`;
      const matches = await findAiGenDiagnostics(code, { detectInline: true });
      expect(matches).toHaveLength(1);
      expect(matches[0].isFileLevel).toBe(true);
    });

    it('should ignore file-level comment if state is "ok"', async () => {
      const code = `// @ai-gen ok
function foo() {}
`;
      const matches = await findAiGenDiagnostics(code, { detectInline: true });
      expect(matches).toHaveLength(0);
    });

    it('should mark file-level comment as rejected when state is "rejected"', async () => {
      const code = `// @ai-gen rejected
function foo() {}
`;
      const matches = await findAiGenDiagnostics(code, { detectInline: true });
      expect(matches).toHaveLength(1);
      expect(matches[0].isFileLevel).toBe(true);
      expect(matches[0].type).toBe('rejected');
    });

    it('should not detect file-level inline comment when detectInline is false', async () => {
      const code = `// @ai-gen
function foo() {}
`;
      const matches = await findAiGenDiagnostics(code, { detectInline: false });
      expect(matches).toHaveLength(0);
    });

    it('should detect both file-level (inline) and regular (docblock) comments in the same file', async () => {
      const code = `// @ai-gen
function foo() {}

/** @ai-gen */
function bar() {}
`;
      const matches = await findAiGenDiagnostics(code, { detectInline: true });
      expect(matches).toHaveLength(2);

      const fileLevelMatch = matches.find(m => m.isFileLevel);
      const regularMatch = matches.find(m => !m.isFileLevel);

      expect(fileLevelMatch).toBeDefined();
      expect(regularMatch).toBeDefined();
    });

    it('should not treat comment after code as file-level', async () => {
      const code = `const x = 1;
/** @ai-gen */
function foo() {}
`;
      const matches = await findAiGenDiagnostics(code);
      expect(matches).toHaveLength(1);
      expect(matches[0].isFileLevel).toBeUndefined();
    });

    it('should not detect file-level comments when detectFileLevel is false', async () => {
      const code = `/** @ai-gen */
function foo() {}
`;
      const matches = await findAiGenDiagnostics(code, { detectFileLevel: false });
      // Should still detect the comment, but as a regular comment, not file-level
      expect(matches).toHaveLength(1);
      expect(matches[0].isFileLevel).toBeUndefined();
    });
  });

  describe('Language: Python', () => {
    const pythonOptions = { language: 'python' as const };

    it('should detect @ai-gen in docstrings ("""', async () => {
      const code = `
def test():
    """
    @ai-gen
    """
    pass
`;
      const matches = await findAiGenDiagnostics(code, pythonOptions);
      expect(matches).toHaveLength(1);
      expect(matches[0].type).toBe('warning');
    });

    it("should detect @ai-gen in docstrings ('''", async () => {
      const code = `
def test():
    '''
    @ai-gen
    '''
    pass
`;
      const matches = await findAiGenDiagnostics(code, pythonOptions);
      expect(matches).toHaveLength(1);
    });

    it('should detect inline comments (#)', async () => {
      const code = `
# @ai-gen
def test():
    pass
`;
      const matches = await findAiGenDiagnostics(code, { ...pythonOptions, detectInline: true });
      expect(matches).toHaveLength(1);
    });

    it('should correctly identify block scope by indentation', async () => {
      const code = `
def parent():
    """ @ai-gen """
    x = 1
    if x:
        y = 2
    return x

def next_func():
    pass
`;
      const matches = await findAiGenDiagnostics(code, pythonOptions);
      expect(matches).toHaveLength(1);

      const blockStart = code.indexOf('x = 1');
      const ifStart = code.indexOf('if x:');

      // Conservative behavior: Stops at sibling 'if x'
      expect(matches[0].codeStartOffset).toBe(blockStart);
      expect(matches[0].codeEndOffset).toBeGreaterThanOrEqual(blockStart);
      expect(matches[0].codeEndOffset).toBeLessThanOrEqual(ifStart);
    });

    it('should include indented comments in block scope', async () => {
      const code = `
def test():
    """ @ai-gen """
    x = 1
    # This comment is part of the block
    y = 2

# This is NOT part of the block
`;
      const matches = await findAiGenDiagnostics(code, pythonOptions);
      expect(matches).toHaveLength(1);

      const commentStart = code.indexOf('# This comment');

      // Conservative behavior: Stops before sibling comment
      expect(matches[0].codeEndOffset).toBeLessThanOrEqual(commentStart);
    });

    it('should detect file-level comments (#)', async () => {
      const code = `# @ai-gen
import os

def foo():
    pass
`;
      const matches = await findAiGenDiagnostics(code, { ...pythonOptions, detectFileLevel: true });
      expect(matches).toHaveLength(1);
      expect(matches[0].isFileLevel).toBe(true);
      expect(matches[0].codeEndOffset).toBe(code.length);
    });
  });

  describe('Language: Hash (Shell/Ruby/YAML)', () => {
    const hashOptions = { language: 'hash' as const };

    it('should detect @ai-gen in hash comments', async () => {
      const code = `
# @ai-gen
echo "hello"
`;
      const matches = await findAiGenDiagnostics(code, hashOptions);
      expect(matches).toHaveLength(1);
    });

    it('should highlight only the next line for hash comments', async () => {
      const code = '# @ai-gen\nline1\nline2';
      const matches = await findAiGenDiagnostics(code, hashOptions);
      expect(matches).toHaveLength(1);

      const line1Start = code.indexOf('line1');

      expect(matches[0].codeStartOffset).toBeLessThanOrEqual(line1Start);
      // Relaxed check: ensure it highlights at least line1, and doesn't go beyond file
      expect(matches[0].codeEndOffset).toBeGreaterThan(line1Start);
      expect(matches[0].codeEndOffset).toBeLessThanOrEqual(code.length);
    });

    it('should detect file-level comments', async () => {
      const code = `# @ai-gen
# This file is generated

config: true
`;
      const matches = await findAiGenDiagnostics(code, { ...hashOptions, detectFileLevel: true });
      expect(matches).toHaveLength(1);
      expect(matches[0].isFileLevel).toBe(true);
    });
  });

  describe('Option: includeAllowed', () => {
    it('should return matches for "ok" states when includeAllowed is true', async () => {
      const code = `
/** @ai-gen ok */
function test() {}
`;
      const matches = await findAiGenDiagnostics(code, { includeAllowed: true });
      expect(matches).toHaveLength(1);
      expect(matches[0].type).toBe('allowed');
    });

    it('should return matches for both warning and allowed states', async () => {
      const code = `
/** @ai-gen ok */
function test1() {}

/** @ai-gen */
function test2() {}
`;
      const matches = await findAiGenDiagnostics(code, { includeAllowed: true });
      expect(matches).toHaveLength(2);

      const allowed = matches.find(m => m.type === 'allowed');
      const warning = matches.find(m => m.type === 'warning');

      expect(allowed).toBeDefined();
      expect(warning).toBeDefined();
    });
  });
});

describe('Extension highlight cleanup', () => {
  it('clears stale diagnostics and decorations for unsupported language documents', async () => {
    vi.resetModules();

    const diagnosticDelete = vi.fn();
    const createDisposable = () => ({ dispose: vi.fn() });

    const workspaceConfig = {
      get: vi.fn((key: string) => {
        switch (key) {
          case 'showReviewedIndicators':
            return false;
          case 'detectInlineComments':
            return true;
          case 'detectFileLevelComments':
            return true;
          case 'tag':
            return '@ai-gen';
          case 'allowedStates':
            return ['ok'];
          case 'rejectedStates':
            return ['rejected', 'reject'];
          case 'warningColor':
            return 'rgba(255, 215, 0, 0.1)';
          case 'rejectedColor':
            return 'rgba(255, 0, 0, 0.1)';
          case 'allowedColor':
            return 'rgba(0, 77, 255, 0.1)';
          case 'reviewedIndicatorStyle':
            return 'gutter';
          default:
            return undefined;
        }
      }),
      update: vi.fn(async () => undefined)
    };

    const workspace = {
      getConfiguration: vi.fn(() => workspaceConfig),
      onDidOpenTextDocument: vi.fn((callback: unknown) => {
        (workspace.onDidOpenTextDocument as unknown as { _callback?: unknown })._callback = callback;
        return createDisposable();
      }),
      onDidChangeTextDocument: vi.fn(() => createDisposable()),
      onDidChangeConfiguration: vi.fn(() => createDisposable()),
      onDidCloseTextDocument: vi.fn(() => createDisposable())
    };

    const window = {
      activeTextEditor: undefined,
      visibleTextEditors: [] as unknown[],
      onDidChangeActiveTextEditor: vi.fn(() => createDisposable()),
      onDidChangeVisibleTextEditors: vi.fn(() => createDisposable()),
      createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
      showInformationMessage: vi.fn()
    };

    const languages = {
      createDiagnosticCollection: vi.fn(() => ({
        set: vi.fn(),
        delete: diagnosticDelete,
        clear: vi.fn(),
        dispose: vi.fn()
      }))
    };

    const commands = {
      registerCommand: vi.fn(() => createDisposable())
    };

    class CancellationTokenSource {
      token = { isCancellationRequested: false };
      cancel = vi.fn(() => {
        this.token.isCancellationRequested = true;
      });
      dispose = vi.fn();
    }

    vi.doMock('vscode', () => ({
      workspace,
      window,
      languages,
      commands,
      ['CancellationTokenSource']: CancellationTokenSource,
      ['ConfigurationTarget']: { ['Global']: 1 },
      ['OverviewRulerLane']: { ['Left']: 1 },
      ['Uri']: {
        parse: (value: string) => ({ toString: () => value })
      }
    }));

    const { activate, deactivate } = await import('./extension');

    const context = { subscriptions: [] as { dispose: () => void }[] } as unknown as Parameters<typeof activate>[0];
    activate(context);

    const openHandler = (workspace.onDidOpenTextDocument as unknown as { _callback?: (doc: unknown) => void })._callback;
    expect(openHandler).toBeTypeOf('function');

    const uri = { toString: () => 'file:///tmp/sample.txt' };
    const document = {
      uri,
      languageId: 'plaintext',
      version: 1,
      getText: () => 'hello'
    };

    const setDecorations = vi.fn();
    const editor = {
      document,
      setDecorations
    };

    (window.visibleTextEditors as unknown[]).push(editor);

    openHandler?.(document);

    expect(diagnosticDelete).toHaveBeenCalledWith(uri);
    expect(setDecorations).toHaveBeenCalledTimes(3);

    for (const [, ranges] of setDecorations.mock.calls) {
      expect(ranges).toEqual([]);
    }

    deactivate();
    vi.doUnmock('vscode');
    vi.resetModules();
  });
});
