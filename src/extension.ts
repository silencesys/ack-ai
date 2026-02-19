import * as vscode from 'vscode';
import { findAiGenDiagnostics, LanguageType } from './analyzer';

let diagnosticCollection: vscode.DiagnosticCollection;
let warningDecorationType: vscode.TextEditorDecorationType;
let rejectedDecorationType: vscode.TextEditorDecorationType;
let allowedDecorationType: vscode.TextEditorDecorationType;
let showReviewedIndicators = false;

interface AnalyzerRuntimeSettings {
    detectInline: boolean;
    detectFileLevel: boolean;
    tag: string;
    allowedStates: string[];
    rejectedStates: string[];
}

let analyzerSettings: AnalyzerRuntimeSettings = {
    detectInline: true,
    detectFileLevel: true,
    tag: '@ai-gen',
    allowedStates: ['ok'],
    rejectedStates: ['rejected', 'reject']
};

// Helper to get the current showReviewedIndicators setting
function getShowReviewedIndicators(): boolean {
    return showReviewedIndicators;
}

function refreshRuntimeSettings(): void {
    const config = vscode.workspace.getConfiguration('ackAi');
    showReviewedIndicators = config.get<boolean>('showReviewedIndicators') ?? false;
    analyzerSettings = {
        detectInline: config.get<boolean>('detectInlineComments') ?? true,
        detectFileLevel: config.get<boolean>('detectFileLevelComments') ?? true,
        tag: config.get<string>('tag') || '@ai-gen',
        allowedStates: config.get<string[]>('allowedStates') || ['ok'],
        rejectedStates: config.get<string[]>('rejectedStates') || ['rejected', 'reject']
    };
}

// Map to manage cancellation tokens per document (URI string)
const tokenSources = new Map<string, vscode.CancellationTokenSource>();
const debounceTimers = new Map<string, NodeJS.Timeout>();

// Cache to store calculated ranges for instant tab switching
interface DecorationCacheEntry {
    version: number;
    warningRanges: vscode.Range[];
    rejectedRanges: vscode.Range[];
    allowedRanges: vscode.Range[];
}
const decorationCache = new Map<string, DecorationCacheEntry>();

export function activate(context: vscode.ExtensionContext) {
    console.log('Ack-AI is now active');

    refreshRuntimeSettings();

    diagnosticCollection = vscode.languages.createDiagnosticCollection('ack-ai');
    context.subscriptions.push(diagnosticCollection);

    updateDecorationTypes();

    if (vscode.window.activeTextEditor) {
        triggerUpdate(vscode.window.activeTextEditor.document);
    }

    // Register toggle command - toggles the setting directly
    context.subscriptions.push(
        vscode.commands.registerCommand('ackAi.toggleAllowedIndicators', async () => {
            const config = vscode.workspace.getConfiguration('ackAi');
            const current = config.get<boolean>('showReviewedIndicators') ?? false;
            await config.update('showReviewedIndicators', !current, vscode.ConfigurationTarget.Global);
            showReviewedIndicators = !current;

            // Note: The onDidChangeConfiguration handler will take care of refreshing
            const status = !current ? 'enabled' : 'disabled';
            vscode.window.showInformationMessage(`Ack-AI: Reviewed code indicators ${status}`);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => triggerUpdate(doc)),

        // Debounce typing events to prevent thrashing
        vscode.workspace.onDidChangeTextDocument(event => {
            const key = event.document.uri.toString();
            const existingTimer = debounceTimers.get(key);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }
            const timer = setTimeout(() => {
                triggerUpdate(event.document);
                debounceTimers.delete(key);
            }, 200); // 200ms debounce
            debounceTimers.set(key, timer);
        }),

        // Handle tab switching / focus change - Instant update from cache
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                triggerUpdate(editor.document, editor);
            }
        }),

        // Handle split view changes or closing/opening groups
        vscode.window.onDidChangeVisibleTextEditors(editors => {
            const seenDocuments = new Set<string>();
            for (const editor of editors) {
                const key = editor.document.uri.toString();
                if (seenDocuments.has(key)) {
                    continue;
                }
                seenDocuments.add(key);
                triggerUpdate(editor.document, editor);
            }
        }),

        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('ackAi')) {
                refreshRuntimeSettings();
                updateDecorationTypes();
                // Clear cache to force re-render with new colors/logic if needed (though ranges might be same, safer to clear)
                decorationCache.clear();
                // Update all visible editors
                vscode.window.visibleTextEditors.forEach(editor => {
                    triggerUpdate(editor.document);
                });
            }
        }),

        // Cleanup tokens and cache when documents are closed
        vscode.workspace.onDidCloseTextDocument(doc => {
            const key = doc.uri.toString();

            const source = tokenSources.get(key);
            if (source) {
                source.cancel();
                source.dispose();
                tokenSources.delete(key);
            }

            const timer = debounceTimers.get(key);
            if (timer) {
                clearTimeout(timer);
                debounceTimers.delete(key);
            }

            decorationCache.delete(key);
        })
    );
}

// Helper to ensure color has minimum opacity (for overview ruler visibility)
function ensureMinOpacity(color: string, minOpacity: number): string {
    // Handle Hex with Alpha (#RRGGBBAA or #RGBA)
    if (color.startsWith('#')) {
        if (color.length === 9) { // #RRGGBBAA
            const alphaHex = color.substring(7, 9);
            const alpha = parseInt(alphaHex, 16) / 255;
            if (alpha < minOpacity) {
                const newAlpha = Math.floor(minOpacity * 255).toString(16).padStart(2, '0');
                return color.substring(0, 7) + newAlpha;
            }
            return color;
        } else if (color.length === 5) { // #RGBA
            const alphaHex = color.substring(4, 5);
            // Expand single digit alpha: 'A' -> 'AA' -> /255
            const alpha = parseInt(alphaHex + alphaHex, 16) / 255;
            if (alpha < minOpacity) {
                const newAlpha = Math.floor(minOpacity * 255).toString(16).padStart(2, '0');
                // Convert to 8-digit hex for precision: #RGB + newAlpha
                const r = color[1], g = color[2], b = color[3];
                return `#${r}${r}${g}${g}${b}${b}${newAlpha}`;
            }
            return color;
        }
        // #RRGGBB or #RGB - assume alpha 1, which is > minOpacity (unless min > 1)
        return color;
    }

    // Handle rgba(r, g, b, a)
    if (color.startsWith('rgba')) {
        const match = color.match(/rgba\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)/);
        if (match) {
            let alpha = parseFloat(match[4]);
            if (alpha < minOpacity) {
                return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${minOpacity})`;
            }
        }
        return color;
    }

    // Handle hsla(h, s, l, a)
    if (color.startsWith('hsla')) {
        const match = color.match(/hsla\s*\(\s*(\d+)\s*,\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*,\s*([0-9.]+)\s*\)/);
        if (match) {
            let alpha = parseFloat(match[4]);
            if (alpha < minOpacity) {
                return `hsla(${match[1]}, ${match[2]}, ${match[3]}, ${minOpacity})`;
            }
        }
        return color;
    }

    // Fallback for rgb() or named colors (assume alpha 1)
    return color;
}

function updateDecorationTypes() {
    const config = vscode.workspace.getConfiguration('ackAi');
    const warningColor = config.get<string>('warningColor') || 'rgba(255, 215, 0, 0.1)';
    const rejectedColor = config.get<string>('rejectedColor') || 'rgba(255, 0, 0, 0.1)';
    const allowedColor = config.get<string>('allowedColor') || '#004DFF';
    const indicatorStyle = config.get<string>('reviewedIndicatorStyle') || 'gutter';

    if (warningDecorationType) {warningDecorationType.dispose();}
    if (rejectedDecorationType) {rejectedDecorationType.dispose();}
    if (allowedDecorationType) {allowedDecorationType.dispose();}

    warningDecorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: warningColor,
        isWholeLine: true,
        overviewRulerColor: 'rgba(255, 215, 0, 0.8)',
        overviewRulerLane: vscode.OverviewRulerLane.Left
    });

    rejectedDecorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: rejectedColor,
        isWholeLine: true,
        overviewRulerColor: 'rgba(255, 0, 0, 0.8)',
        overviewRulerLane: vscode.OverviewRulerLane.Left
    });

    // Configure allowed code indicator based on style preference
    if (indicatorStyle === 'background') {
        allowedDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: allowedColor,
            isWholeLine: true,
            overviewRulerColor: allowedColor,
            overviewRulerLane: vscode.OverviewRulerLane.Left
        });
    } else {
        // Default to gutter indicator (like Git extension)

        // Ensure the overview ruler AND the gutter icon are visible even if the user picked a very subtle color
        const gutterColor = ensureMinOpacity(allowedColor, 0.3);

        // Generate SVG dynamically to respect the allowedColor
        // We use a simple rect like the original file: images/gutter-reviewed.svg
        const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="6" height="16" viewBox="0 0 6 16"><rect x="0" y="0" width="1" height="16" fill="${gutterColor}" /></svg>`;
        const svg64 = Buffer.from(svgContent).toString('base64');
        const gutterIconUri = vscode.Uri.parse(`data:image/svg+xml;base64,${svg64}`);

        allowedDecorationType = vscode.window.createTextEditorDecorationType({
            gutterIconPath: gutterIconUri,
            gutterIconSize: 'contain',
            overviewRulerColor: gutterColor,
            overviewRulerLane: vscode.OverviewRulerLane.Left
        });
    }
}

// Map VS Code languageId to analyzer LanguageType
function getAnalyzerLanguage(languageId: string): LanguageType | null {
    switch (languageId) {
        // C-style comments: // and /** */
        case 'javascript':
        case 'typescript':
        case 'javascriptreact':
        case 'typescriptreact':
        case 'php':
        case 'java':
        case 'c':
        case 'cpp':
        case 'csharp':
        case 'go':
        case 'rust':
        case 'swift':
        case 'kotlin':
        case 'scala':
        case 'dart':
        case 'groovy':
        case 'objective-c':
        case 'objective-cpp':
            return 'javascript'; // C-style comments
        // Python-style: # and """ or '''
        case 'python':
            return 'python';
        // Hash-only comments: #
        case 'ruby':
        case 'shellscript':
        case 'perl':
        case 'r':
        case 'yaml':
        case 'dockerfile':
        case 'makefile':
        case 'coffeescript':
        case 'powershell':
        case 'elixir':
            return 'hash';
        default:
            return null; // Unsupported language
    }
}

function triggerUpdate(document: vscode.TextDocument, editor?: vscode.TextEditor) {
    const key = document.uri.toString();

    // Check language support first to avoid overhead
    const language = getAnalyzerLanguage(document.languageId);
    if (!language) {
        clearDocumentArtifacts(document, editor);
        return;
    }

    // Check Cache First
    const cached = decorationCache.get(key);
    if (cached && cached.version === document.version) {
        applyDecorations(document, cached.warningRanges, cached.rejectedRanges, cached.allowedRanges, editor);
        return;
    }

    // Cancel previous running task for THIS document
    const previousSource = tokenSources.get(key);
    if (previousSource) {
        previousSource.cancel();
        previousSource.dispose();
    }

    const source = new vscode.CancellationTokenSource();
    tokenSources.set(key, source);

    // Use setImmediate to defer execution slightly, keeping typing responsive
    setImmediate(() => {
        updateDiagnostics(document, source.token, language);
    });
}

function clearDocumentArtifacts(document: vscode.TextDocument, specificEditor?: vscode.TextEditor): void {
    const key = document.uri.toString();

    diagnosticCollection.delete(document.uri);
    decorationCache.delete(key);

    const source = tokenSources.get(key);
    if (source) {
        source.cancel();
        source.dispose();
        tokenSources.delete(key);
    }

    if (specificEditor) {
        if (specificEditor.document.uri.toString() === key) {
            specificEditor.setDecorations(warningDecorationType, []);
            specificEditor.setDecorations(rejectedDecorationType, []);
            specificEditor.setDecorations(allowedDecorationType, []);
        }
        return;
    }

    vscode.window.visibleTextEditors.forEach(editor => {
        if (editor.document.uri.toString() === key) {
            editor.setDecorations(warningDecorationType, []);
            editor.setDecorations(rejectedDecorationType, []);
            editor.setDecorations(allowedDecorationType, []);
        }
    });
}

async function updateDiagnostics(document: vscode.TextDocument, token: vscode.CancellationToken, language: LanguageType) {
    if (token.isCancellationRequested) {return;}

    const text = document.getText();
    const { detectInline, detectFileLevel, tag, allowedStates, rejectedStates } = analyzerSettings;

    // Pass token to analyzer for deep cancellation
    // Include allowed matches if indicator is enabled
    const matches = await findAiGenDiagnostics(text, {
        detectInline,
        detectFileLevel,
        tag,
        allowedStates,
        rejectedStates,
        language,
        includeAllowed: getShowReviewedIndicators()
    }, token);

    if (token.isCancellationRequested) {return;}

    const diagnostics: vscode.Diagnostic[] = [];
    const warningRanges: vscode.Range[] = [];
    const rejectedRanges: vscode.Range[] = [];
    const allowedRanges: vscode.Range[] = [];
    const allowedStatesMsg = allowedStates.length > 0 ? allowedStates.join("' or '") : "ok";

    for (const match of matches) {
        const tagRange = new vscode.Range(
            document.positionAt(match.tagStartOffset),
            document.positionAt(match.tagEndOffset)
        );

        // Only create diagnostics for warning/rejected, not for allowed
        if (match.type !== 'allowed') {
            const msg = match.type === 'rejected'
                ? "Code explicitly marked as rejected."
                : `AI-generated code requires verification. Append '${allowedStatesMsg}' to the tag to dismiss.`;

            const severity = match.type === 'rejected'
                ? vscode.DiagnosticSeverity.Error
                : vscode.DiagnosticSeverity.Warning;

            const tagDiagnostic = new vscode.Diagnostic(tagRange, msg, severity);
            tagDiagnostic.source = 'ack-ai';
            diagnostics.push(tagDiagnostic);
        }

        if (match.codeStartOffset < match.codeEndOffset) {
            const codeRange = new vscode.Range(
                document.positionAt(match.codeStartOffset),
                document.positionAt(match.codeEndOffset)
            );

            if (match.type === 'rejected') {
                rejectedRanges.push(codeRange);
            } else if (match.type === 'allowed') {
                allowedRanges.push(codeRange);
            } else {
                warningRanges.push(codeRange);
            }
        }
    }

    diagnosticCollection.set(document.uri, diagnostics);

    // Update Cache
    decorationCache.set(document.uri.toString(), {
        version: document.version,
        warningRanges,
        rejectedRanges,
        allowedRanges
    });

    applyDecorations(document, warningRanges, rejectedRanges, allowedRanges);
}

function applyDecorations(document: vscode.TextDocument, warningRanges: vscode.Range[], rejectedRanges: vscode.Range[], allowedRanges: vscode.Range[], specificEditor?: vscode.TextEditor) {
    // Only show allowed decorations if the feature is enabled
    const effectiveAllowedRanges = showReviewedIndicators ? allowedRanges : [];
    const documentKey = document.uri.toString();

    if (specificEditor) {
        if (specificEditor.document.uri.toString() === documentKey) {
            specificEditor.setDecorations(warningDecorationType, warningRanges);
            specificEditor.setDecorations(rejectedDecorationType, rejectedRanges);
            specificEditor.setDecorations(allowedDecorationType, effectiveAllowedRanges);
        }
        return;
    }

    vscode.window.visibleTextEditors.forEach(editor => {
        if (editor.document.uri.toString() === documentKey) {
            editor.setDecorations(warningDecorationType, warningRanges);
            editor.setDecorations(rejectedDecorationType, rejectedRanges);
            editor.setDecorations(allowedDecorationType, effectiveAllowedRanges);
        }
    });
}

export function deactivate() {
    // Cancel all pending analysis tasks
    tokenSources.forEach(source => {
        source.cancel();
        source.dispose();
    });
    tokenSources.clear();

    // Clear all pending debounce timers
    debounceTimers.forEach(timer => clearTimeout(timer));
    debounceTimers.clear();

    // Clear decoration cache
    decorationCache.clear();

    // Clear diagnostics
    if (diagnosticCollection) {
        diagnosticCollection.clear();
    }

    // Dispose decoration types
    if (warningDecorationType) {warningDecorationType.dispose();}
    if (rejectedDecorationType) {rejectedDecorationType.dispose();}
    if (allowedDecorationType) {allowedDecorationType.dispose();}
}
