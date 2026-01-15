import * as vscode from 'vscode';
import { findAiGenDiagnostics } from './analyzer';

let diagnosticCollection: vscode.DiagnosticCollection;
let warningDecorationType: vscode.TextEditorDecorationType;
let rejectedDecorationType: vscode.TextEditorDecorationType;
let timeout: NodeJS.Timeout | undefined = undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('AI Code Reviewer is now active');

    diagnosticCollection = vscode.languages.createDiagnosticCollection('ai-gen-reviewer');
    context.subscriptions.push(diagnosticCollection);

    // Initial setup of decorations (will be updated on config change)
    updateDecorationTypes();

    if (vscode.window.activeTextEditor) {
        updateDiagnostics(vscode.window.activeTextEditor.document);
    }

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => updateDiagnostics(doc)),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = undefined;
            }
            timeout = setTimeout(() => {
                updateDiagnostics(event.document);
            }, 500); // Debounce 500ms
        }),
        // Listen for configuration changes to update colors
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('aiGenReviewer')) {
                updateDecorationTypes();
                if (vscode.window.activeTextEditor) {
                    updateDiagnostics(vscode.window.activeTextEditor.document);
                }
            }
        })
    );
}

function updateDecorationTypes() {
    const config = vscode.workspace.getConfiguration('aiGenReviewer');
    const warningColor = config.get<string>('warningColor') || 'rgba(255, 215, 0, 0.1)';
    const rejectedColor = config.get<string>('rejectedColor') || 'rgba(255, 0, 0, 0.1)';

    // Dispose old decorations if they exist to avoid leaks/stale colors
    if (warningDecorationType) warningDecorationType.dispose();
    if (rejectedDecorationType) rejectedDecorationType.dispose();

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

function updateDiagnostics(document: vscode.TextDocument) {
    // Check language support
    const supportedLanguages = [
        'php',
        'javascript',
        'typescript',
        'javascriptreact',
        'typescriptreact'
    ];

    if (!supportedLanguages.includes(document.languageId)) {
        return;
    }

    const text = document.getText();
    const config = vscode.workspace.getConfiguration('aiGenReviewer');
    const detectInline = config.get<boolean>('detectInlineComments') ?? true;
    const tag = config.get<string>('tag') || '@ai-gen';
    const allowedStates = config.get<string[]>('allowedStates') || ['ok'];
    const rejectedStates = config.get<string[]>('rejectedStates') || ['rejected', 'reject'];

    const matches = findAiGenDiagnostics(text, { detectInline, tag, allowedStates, rejectedStates });
    
    const diagnostics: vscode.Diagnostic[] = [];
    const warningRanges: vscode.Range[] = [];
    const rejectedRanges: vscode.Range[] = [];

    const allowedStatesMsg = allowedStates.length > 0 ? allowedStates.join("' or '") : "ok";

    for (const match of matches) {
        // Diagnostic 1: The Tag itself (Squiggly Warning)
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
        tagDiagnostic.source = 'ai-gen-reviewer';
        diagnostics.push(tagDiagnostic);

        // Decoration: The Code Block (Background Highlight)
        // Ensure valid range
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

    // Apply decorations to all visible editors displaying this document
    vscode.window.visibleTextEditors.forEach(editor => {
        if (editor.document.uri.toString() === document.uri.toString()) {
            editor.setDecorations(warningDecorationType, warningRanges);
            editor.setDecorations(rejectedDecorationType, rejectedRanges);
        }
    });
}

export function deactivate() {
    if (warningDecorationType) warningDecorationType.dispose();
    if (rejectedDecorationType) rejectedDecorationType.dispose();
}