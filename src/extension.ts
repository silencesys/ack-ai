import * as vscode from 'vscode';
import { findAiGenDiagnostics } from './analyzer';

let diagnosticCollection: vscode.DiagnosticCollection;
let highlightDecorationType: vscode.TextEditorDecorationType;
let timeout: NodeJS.Timeout | undefined = undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('AI Code Reviewer is now active');

    diagnosticCollection = vscode.languages.createDiagnosticCollection('ai-gen-reviewer');
    highlightDecorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 215, 0, 0.1)', // Gold with low opacity
        isWholeLine: true,
        overviewRulerColor: 'rgba(255, 215, 0, 0.8)',
        overviewRulerLane: vscode.OverviewRulerLane.Left
    });

    context.subscriptions.push(diagnosticCollection);
    context.subscriptions.push(highlightDecorationType);

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
        })
    );
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

    const matches = findAiGenDiagnostics(text, { detectInline, tag, allowedStates });
    
    const diagnostics: vscode.Diagnostic[] = [];
    const highlightRanges: vscode.Range[] = [];

    const allowedStatesMsg = allowedStates.length > 0 ? allowedStates.join("' or '") : "ok";

    for (const match of matches) {
        // Diagnostic 1: The Tag itself (Squiggly Warning)
        const tagRange = new vscode.Range(
            document.positionAt(match.tagStartOffset),
            document.positionAt(match.tagEndOffset)
        );

        const tagDiagnostic = new vscode.Diagnostic(
            tagRange,
            `AI-generated code requires verification. Append '${allowedStatesMsg}' to the tag to dismiss.`,
            vscode.DiagnosticSeverity.Warning
        );
        tagDiagnostic.source = 'ai-gen-reviewer';
        diagnostics.push(tagDiagnostic);

        // Decoration: The Code Block (Background Highlight)
        // Ensure valid range
        if (match.codeStartOffset < match.codeEndOffset) {
            const codeRange = new vscode.Range(
                document.positionAt(match.codeStartOffset),
                document.positionAt(match.codeEndOffset)
            );
            highlightRanges.push(codeRange);
        }
    }

    diagnosticCollection.set(document.uri, diagnostics);

    // Apply decorations to all visible editors displaying this document
    vscode.window.visibleTextEditors.forEach(editor => {
        if (editor.document.uri.toString() === document.uri.toString()) {
            editor.setDecorations(highlightDecorationType, highlightRanges);
        }
    });
}

export function deactivate() {}
