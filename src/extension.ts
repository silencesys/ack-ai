import * as vscode from 'vscode';
import { findAiGenDiagnostics } from './analyzer';

let diagnosticCollection: vscode.DiagnosticCollection;
let warningDecorationType: vscode.TextEditorDecorationType;
let rejectedDecorationType: vscode.TextEditorDecorationType;

// Map to manage cancellation tokens per document (URI string)
const tokenSources = new Map<string, vscode.CancellationTokenSource>();
const debounceTimers = new Map<string, NodeJS.Timeout>();

// Cache to store calculated ranges for instant tab switching
interface DecorationCacheEntry {
    version: number;
    warningRanges: vscode.Range[];
    rejectedRanges: vscode.Range[];
}
const decorationCache = new Map<string, DecorationCacheEntry>();

export function activate(context: vscode.ExtensionContext) {
    console.log('Ack-AI is now active');

    diagnosticCollection = vscode.languages.createDiagnosticCollection('ack-ai');
    context.subscriptions.push(diagnosticCollection);

    updateDecorationTypes();

    if (vscode.window.activeTextEditor) {
        triggerUpdate(vscode.window.activeTextEditor.document);
    }

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
            editors.forEach(editor => triggerUpdate(editor.document));
        }),

        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('ackAi')) {
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

function updateDecorationTypes() {
    const config = vscode.workspace.getConfiguration('ackAi');
    const warningColor = config.get<string>('warningColor') || 'rgba(255, 215, 0, 0.1)';
    const rejectedColor = config.get<string>('rejectedColor') || 'rgba(255, 0, 0, 0.1)';

    if (warningDecorationType) {warningDecorationType.dispose();}
    if (rejectedDecorationType) {rejectedDecorationType.dispose();}

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
}

function triggerUpdate(document: vscode.TextDocument, editor?: vscode.TextEditor) {
    // Check language support first to avoid overhead
    const supportedLanguages = [
        'php', 'javascript', 'typescript', 'javascriptreact', 'typescriptreact'
    ];
    if (!supportedLanguages.includes(document.languageId)) {
        return;
    }

    const key = document.uri.toString();

    // Check Cache First
    const cached = decorationCache.get(key);
    if (cached && cached.version === document.version) {
        applyDecorations(document, cached.warningRanges, cached.rejectedRanges, editor);
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
        updateDiagnostics(document, source.token);
    });
}

async function updateDiagnostics(document: vscode.TextDocument, token: vscode.CancellationToken) {
    if (token.isCancellationRequested) {return;}

    const text = document.getText();
    const config = vscode.workspace.getConfiguration('ackAi');
    const detectInline = config.get<boolean>('detectInlineComments') ?? true;
    const detectFileLevel = config.get<boolean>('detectFileLevelComments') ?? true;
    const tag = config.get<string>('tag') || '@ai-gen';
    const allowedStates = config.get<string[]>('allowedStates') || ['ok'];
    const rejectedStates = config.get<string[]>('rejectedStates') || ['rejected', 'reject'];

    // Pass token to analyzer for deep cancellation
    const matches = await findAiGenDiagnostics(text, { detectInline, detectFileLevel, tag, allowedStates, rejectedStates }, token);

    if (token.isCancellationRequested) {return;}

    const diagnostics: vscode.Diagnostic[] = [];
    const warningRanges: vscode.Range[] = [];
    const rejectedRanges: vscode.Range[] = [];
    const allowedStatesMsg = allowedStates.length > 0 ? allowedStates.join("' or '") : "ok";

    for (const match of matches) {
        const tagRange = new vscode.Range(
            document.positionAt(match.tagStartOffset),
            document.positionAt(match.tagEndOffset)
        );

        const msg = match.type === 'rejected'
            ? "Code explicitly marked as rejected."
            : `AI-generated code requires verification. Append '${allowedStatesMsg}' to the tag to dismiss.`;

        const severity = match.type === 'rejected'
            ? vscode.DiagnosticSeverity.Error
            : vscode.DiagnosticSeverity.Warning;

        const tagDiagnostic = new vscode.Diagnostic(tagRange, msg, severity);
        tagDiagnostic.source = 'ack-ai';
        diagnostics.push(tagDiagnostic);

        if (match.codeStartOffset < match.codeEndOffset) {
            const codeRange = new vscode.Range(
                document.positionAt(match.codeStartOffset),
                document.positionAt(match.codeEndOffset)
            );

            if (match.type === 'rejected') {
                rejectedRanges.push(codeRange);
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
        rejectedRanges
    });

    applyDecorations(document, warningRanges, rejectedRanges);
}

function applyDecorations(document: vscode.TextDocument, warningRanges: vscode.Range[], rejectedRanges: vscode.Range[], specificEditor?: vscode.TextEditor) {
    if (specificEditor) {
        if (specificEditor.document.uri.toString() === document.uri.toString()) {
            specificEditor.setDecorations(warningDecorationType, warningRanges);
            specificEditor.setDecorations(rejectedDecorationType, rejectedRanges);
        }
        return;
    }

    vscode.window.visibleTextEditors.forEach(editor => {
        if (editor.document.uri.toString() === document.uri.toString()) {
            editor.setDecorations(warningDecorationType, warningRanges);
            editor.setDecorations(rejectedDecorationType, rejectedRanges);
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
}
