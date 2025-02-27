import * as vscode from 'vscode';
import * as cfg from '../configuration';
import * as util from '../utility';
import SourceDocument from '../SourceDocument';
import CSymbol from '../CSymbol';
import SubSymbol from '../SubSymbol';
import { ProposedPosition } from '../ProposedPosition';
import { showSingleQuickPick, showMultiQuickPick, MultiQuickPickOptions } from '../QuickPick';
import { createMatchingSourceFile } from './createSourceFile';
import { getMatchingHeaderSource, logger } from '../extension';
import FunctionSignature from '../FunctionSignature';
import { getParameterTypes } from '../parsing';


export const title = {
    currentFile: 'Add Definition in this file',
    matchingSourceFile: 'Add Definition in matching source file',
    multiple: 'Add Definitions...',
    constructorCurrentFile: 'Generate Constructor in this file',
    constructorMatchingSourceFile: 'Generate Constructor in matching source file'
};

export const failure = {
    noActiveTextEditor: 'No active text editor detected.',
    noDocumentSymbol: 'No document symbol detected.',
    notHeaderFile: 'This file is not a header file.',
    noFunctionDeclaration: 'No function declaration detected.',
    noMatchingSourceFile: 'No matching source file was found.',
    hasUnspecializedTemplate: 'Unspecialized templates must be defined in the file that they are declared.',
    isConstexpr: 'Constexpr functions must be defined in the file that they are declared.',
    isConsteval: 'Consteval functions must be defined in the file that they are declared.',
    isInline: 'Inline functions must be defined in the file that they are declared.',
    definitionExists: 'A definition for this function already exists.',
    noUndefinedFunctions: 'No undefined functions found in this file.'
};

export async function addDefinitionInSourceFile(): Promise<boolean | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        logger.alertError(failure.noActiveTextEditor);
        return;
    }

    const headerDoc = new SourceDocument(editor.document);
    if (!headerDoc.isHeader()) {
        logger.alertWarning(failure.notHeaderFile);
        return;
    }

    const [matchingUri, symbol] = await Promise.all([
        getMatchingHeaderSource(headerDoc.uri),
        headerDoc.getSymbol(editor.selection.start)
    ]);

    if (!symbol?.isFunctionDeclaration()) {
        logger.alertWarning(failure.noFunctionDeclaration);
        return;
    } else if (!matchingUri) {
        logger.alertWarning(failure.noMatchingSourceFile);
        return;
    } else if (symbol.isInline()) {
        logger.alertInformation(failure.isInline);
        return;
    } else if (symbol.isConstexpr()) {
        logger.alertInformation(failure.isConstexpr);
        return;
    } else if (symbol.isConsteval()) {
        logger.alertInformation(failure.isConsteval);
        return;
    } else if (symbol.hasUnspecializedTemplate()) {
        logger.alertInformation(failure.hasUnspecializedTemplate);
        return;
    }

    return addDefinition(symbol, headerDoc, matchingUri);
}

export async function addDefinitionInCurrentFile(): Promise<boolean | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        logger.alertError(failure.noActiveTextEditor);
        return;
    }

    const sourceDoc = new SourceDocument(editor.document);

    const symbol = await sourceDoc.getSymbol(editor.selection.start);
    if (!symbol?.isFunctionDeclaration()) {
        logger.alertWarning(failure.noFunctionDeclaration);
        return;
    }

    return addDefinition(symbol, sourceDoc, sourceDoc.uri);
}

export async function addDefinition(
    functionDeclaration: CSymbol,
    declarationDoc: SourceDocument,
    targetUri: vscode.Uri,
    skipExistingDefinitionCheck?: boolean
): Promise<boolean | undefined> {
    if (!skipExistingDefinitionCheck) {
        const existingDefinition = await functionDeclaration.findDefinition();
        if (existingDefinition) {
            if (!cfg.revealNewDefinition(declarationDoc)) {
                logger.alertInformation(failure.definitionExists);
                return;
            }
            const editor = await vscode.window.showTextDocument(existingDefinition.uri);
            editor.revealRange(existingDefinition.range, vscode.TextEditorRevealType.InCenter);
            return;
        }
    }

    const p_initializers = getInitializersIfFunctionIsConstructor(functionDeclaration);

    const targetDoc = (targetUri.fsPath === declarationDoc.uri.fsPath)
            ? declarationDoc
            : await SourceDocument.open(targetUri);
    const targetPos = await declarationDoc.findSmartPositionForFunctionDefinition(functionDeclaration, targetDoc);

    const functionSkeleton = await constructFunctionSkeleton(
            functionDeclaration, targetDoc, targetPos, p_initializers);

    if (functionSkeleton === undefined) {
        return;
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.insert(targetDoc.uri, targetPos, functionSkeleton);
    const success = await vscode.workspace.applyEdit(workspaceEdit);

    if (success && cfg.revealNewDefinition(declarationDoc)) {
        await revealNewFunction(workspaceEdit, targetDoc);
    }

    return success;
}

export async function addDefinitions(
    sourceDoc?: SourceDocument, matchingUri?: vscode.Uri
): Promise<boolean | undefined> {
    if (!sourceDoc) {
        // Command was called from the command-palette
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            logger.alertError(failure.noActiveTextEditor);
            return;
        }

        sourceDoc = new SourceDocument(editor.document);
        matchingUri = await getMatchingHeaderSource(sourceDoc.uri);
    }

    const functionDeclarations: CSymbol[] = [];
    (await sourceDoc.allFunctions()).forEach(functionSymbol => {
        if (functionSymbol.isFunctionDeclaration()) {
            functionDeclarations.push(functionSymbol);
        }
    });

    const undefinedFunctions = await findAllUndefinedFunctions(functionDeclarations);
    if (!undefinedFunctions) {
        return;
    } else if (undefinedFunctions.length === 0) {
        logger.alertInformation(failure.noUndefinedFunctions);
        return;
    }

    const selection = await promptUserForFunctionsAndTargetUri(undefinedFunctions, sourceDoc, matchingUri);
    if (!selection) {
        return;
    }

    const targetDoc = (selection.targetUri.fsPath === sourceDoc.uri.fsPath)
            ? sourceDoc
            : await SourceDocument.open(selection.targetUri);

    const workspaceEdit = await generateDefinitionsWorkspaceEdit(selection.functions, sourceDoc, targetDoc);
    if (!workspaceEdit) {
        return;
    }

    const success = await vscode.workspace.applyEdit(workspaceEdit);

    if (success && cfg.revealNewDefinition(sourceDoc)) {
        await revealNewFunction(workspaceEdit, targetDoc);
    }

    return success;
}

type Initializer = CSymbol | SubSymbol;

interface InitializerItem extends vscode.QuickPickItem {
    initializer: Initializer;
}

async function getInitializersIfFunctionIsConstructor(
    functionDeclaration: CSymbol, token?: vscode.CancellationToken
): Promise<Initializer[] | undefined> {
    if (!functionDeclaration.isConstructor() || !functionDeclaration.parent?.isClassType()) {
        return [];
    }
    const parentClass = functionDeclaration.parent;

    const initializers: Initializer[] = [];
    if (parentClass.constructors().length > 1) {
        initializers.push(parentClass);
    }
    initializers.push(...parentClass.baseClasses(), ...parentClass.nonStaticMemberVariables());

    if (initializers.length === 0) {
        return [];
    }

    const initializerItems: InitializerItem[] = [];
    initializers.forEach(initializer => {
        const initializerItem: InitializerItem = { label: '', initializer: initializer };
        if (initializer === parentClass) {
            initializerItem.label = '$(symbol-class) ' + initializer.name;
            initializerItem.description = 'Delegating constructor (cannot be used with any other initializers)';
        } else if (initializer instanceof SubSymbol) {
            initializerItem.label = '$(symbol-class) ' + initializer.text();
            initializerItem.description = 'Base class constructor';
        } else {
            initializerItem.label = '$(symbol-field) ' + initializer.name;
            initializerItem.description = util.formatSignature(initializer);
        }
        initializerItems.push(initializerItem);
    });

    const selectedInitializers = await showInitializersQuickPick(initializerItems, functionDeclaration, parentClass, token);
    if (!selectedInitializers) {
        return;
    }

    parentClass.memberVariablesThatRequireInitialization().forEach(memberVariable => {
        if (!selectedInitializers.some(initializer => initializer.name === memberVariable.name)) {
            selectedInitializers.push(memberVariable);
        }
    });
    selectedInitializers.sort(util.sortByRange);

    return selectedInitializers;
}

async function showInitializersQuickPick(
    initializerItems: InitializerItem[],
    ctorDeclaration: CSymbol,
    parentClass: CSymbol,
    token?: vscode.CancellationToken
): Promise<Initializer[] | undefined> {
    const options: MultiQuickPickOptions<InitializerItem> = {
        matchOnDescription: true,
        ignoreFocusOut: true,
        title: `Select initializers for "${util.formatSignature(ctorDeclaration)}"`
    };

    if (initializerItems[0].initializer === parentClass) {
        let lastSelection: readonly InitializerItem[] = initializerItems.filter(item => item.picked);
        options.onDidChangeSelection = (selectedItems, quickPick) => {
            if ((lastSelection.length < initializerItems.length - 1
                    && selectedItems.length === initializerItems.length)
                || (lastSelection[0].initializer === parentClass
                    && selectedItems.length > lastSelection.length)
            ) {
                selectedItems.shift();
                quickPick.selectedItems = selectedItems;
            } else if (selectedItems.some(item => item.initializer === parentClass)
                    && !lastSelection.some(item => item.initializer === parentClass)) {
                quickPick.selectedItems = [initializerItems[0]];
            }
            lastSelection = quickPick.selectedItems;
        };
    }

    const selectedItems = await showMultiQuickPick(initializerItems, options, token);

    return selectedItems?.map(item => item.initializer);
}

async function constructFunctionSkeleton(
    functionDeclaration: CSymbol,
    targetDoc: SourceDocument,
    position: ProposedPosition,
    p_initializers: Promise<Initializer[] | undefined>
): Promise<string | undefined> {
    const curlyBraceFormat = cfg.functionCurlyBraceFormat(targetDoc.languageId, targetDoc);
    const eol = targetDoc.endOfLine;
    const indentation = util.indentation();

    const [definition, initializers] = await Promise.all([
        functionDeclaration.newFunctionDefinition(targetDoc, position),
        p_initializers
    ]);

    if (initializers === undefined) {
        // Undefined only when the user cancels the QuickPick, so return.
        return;
    }

    const initializerList = constructInitializerList(functionDeclaration, initializers, eol);

    let functionSkeleton: string;
    if (curlyBraceFormat === cfg.CurlyBraceFormat.NewLine
            || (curlyBraceFormat === cfg.CurlyBraceFormat.NewLineCtorDtor
            && (functionDeclaration.isConstructor() || functionDeclaration.isDestructor()))) {
        // Opening brace on new line.
        functionSkeleton = definition + initializerList + eol + '{' + eol + indentation + eol + '}';
    } else {
        // Opening brace on same line.
        functionSkeleton = definition + initializerList + ' {' + eol + indentation + eol + '}';
    }

    return position.formatTextToInsert(functionSkeleton, targetDoc);
}

function constructInitializerList(functionDeclaration: CSymbol, initializers: Initializer[], eol: string): string {
    if (initializers.length === 0) {
        return '';
    }

    let initializerBody = cfg.bracedInitialization(initializers[0].uri) ? '{},' : '(),';

    const functionList = new FunctionSignature( functionDeclaration );
    let copyCtr = false;

    if ( functionList.parameters.length === 1 ) {

        const isConstReference = functionList.parameters[0].text.match( /^\s*const\s*(\w+)\s*\&/ );
        // return { 'const TYPE & ARG', 'TYPE' }  
        
        if (isConstReference !== null && isConstReference.length > 0 ) {
            const typeName = isConstReference[1];

            if ( typeName === functionDeclaration.name ){
                initializerBody = cfg.bracedInitialization(initializers[0].uri) ? '{ ' + functionList.parameters[0].name + ' ' : '( ' + functionList.parameters[0].name + '';
                copyCtr = true;
            }
        }
    }

    const indentation = util.indentation();

    let initializerList = eol + indentation + ': ';
    if ( copyCtr ) {
        const endOfInit = cfg.bracedInitialization(initializers[0].uri) ? '},' : '),';

        initializers.forEach(initializer => initializerList += initializer.name + initializerBody + ( initializer instanceof SubSymbol ? '' : '.' + initializer.name ) + endOfInit + eol + indentation + '  ');
    } else {
        initializers.forEach(initializer => initializerList += initializer.name + initializerBody + eol + indentation + '  ');
    }

    // Remove last element.
    return initializerList.trimEnd().slice(0, -1);
}

export async function revealNewFunction(workspaceEdit: vscode.WorkspaceEdit, targetDoc: vscode.TextDocument): Promise<void> {
    const textEdits = workspaceEdit.get(targetDoc.uri);
    if (textEdits.length === 0) {
        return;
    }

    const editor = await vscode.window.showTextDocument(targetDoc);
    const firstEdit = textEdits[0];
    const start = firstEdit.range.start;
    util.revealRange(editor, new vscode.Range(start, start.translate(util.lineCount(firstEdit.newText))));

    const cursorPosition = targetDoc.validatePosition(getPositionForCursor(start, firstEdit.newText));
    editor.selection = new vscode.Selection(cursorPosition, cursorPosition);
}

function getPositionForCursor(position: vscode.Position, functionSkeleton: string): vscode.Position {
    const lines = functionSkeleton.split('\n');
    for (let i = 0; i < lines.length; ++i) {
        if (lines[i].trimStart().startsWith(':')) {
            // The function is a constructor, so we want to position the cursor in the first initializer.
            let index = lines[i].lastIndexOf(')');
            if (index === -1) {
                index = lines[i].lastIndexOf('}');
                if (index === -1) {
                    return position;
                }
            }
            return new vscode.Position(i + position.line, index);
        }
        if (lines[i].trimEnd().endsWith('{')) {
            return new vscode.Position(i + 1 + position.line, lines[i + 1].length);
        }
    }
    return position;
}

/**
 * Returns the functionDeclarations that do not have a definition.
 * Returns undefined if the user cancels the operation.
 */
async function findAllUndefinedFunctions(functionDeclarations: CSymbol[]): Promise<CSymbol[] | undefined> {
    const undefinedFunctions: CSymbol[] = [];

    async function findDefinitionsForNextChunkOfFunctions(i: number): Promise<void> {
        const p_declarationDefinitionLinks: Promise<util.DeclarationDefinitionLink>[] = [];
        functionDeclarations.slice(i, i + 10).forEach(declaration => {
            p_declarationDefinitionLinks.push(util.makeDeclDefLink(declaration));
        });

        (await Promise.all(p_declarationDefinitionLinks)).forEach(link => {
            if (!link.definition) {
                undefinedFunctions.push(link.declaration);
            }
        });
    }

    await findDefinitionsForNextChunkOfFunctions(0);

    if (functionDeclarations.length <= 10) {
        return undefinedFunctions;
    }

    const increment = (10 / functionDeclarations.length) * 100;
    let userCancelledOperation = false;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Finding undefined functions',
        cancellable: true
    }, async (progress, token) => {
        for (let i = 10; i < functionDeclarations.length; i += 10) {
            if (token.isCancellationRequested) {
                userCancelledOperation = true;
                return;
            }

            progress.report({
                message: `${i}/${functionDeclarations.length} functions checked`,
                increment: increment
            });

            await findDefinitionsForNextChunkOfFunctions(i);
        }

        progress.report({
            message: `${functionDeclarations.length}/${functionDeclarations.length}`,
            increment: increment
        });
    });

    if (!userCancelledOperation) {
        return undefinedFunctions;
    }
}

type WorkspaceEditArguments = [vscode.Uri, vscode.Position, string];

interface WorkspaceEditArgumentsEntry {
    declaration: CSymbol;
    args: WorkspaceEditArguments;
}

export async function generateDefinitionsWorkspaceEdit(
    functionDeclarations: CSymbol[],
    declarationDoc: SourceDocument,
    targetDoc: SourceDocument
): Promise<vscode.WorkspaceEdit | undefined> {
    /* Since generating constructors requires additional user input, we must generate them
     * separately, one at a time. In order to insert them all in the same order that their
     * declarations appear in the file, we map the declarations to the WorkspaceEditArguments
     * and insert them all into the WorkspaceEdit at the end. */
    const ctors: CSymbol[] = [];
    const nonCtors: CSymbol[] = [];
    functionDeclarations.forEach(declaration => {
        if (declaration.isConstructor()) {
            ctors.push(declaration);
        } else {
            nonCtors.push(declaration);
        }
    });

    const allArgs = new WeakMap<CSymbol, WorkspaceEditArguments>();

    async function generateNextChunkOfNonConstructors(i: number): Promise<void> {
        const p_argsEntries: Promise<WorkspaceEditArgumentsEntry | undefined>[] = [];
        nonCtors.slice(i, i + 5).forEach(declaration => {
            p_argsEntries.push(getWorkspaceEditArgumentsEntry(declaration, declarationDoc, targetDoc));
        });

        (await Promise.all(p_argsEntries)).forEach(entry => {
            if (entry) {
                allArgs.set(entry.declaration, entry.args);
            }
        });
    }

    let userCancelledOperation = false;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Generating function definitions',
        cancellable: true
    }, async (progress, token) => {
        progress.report({ message: `${0}/${functionDeclarations.length} generated`, increment: 0 });
        const increment = (1 / functionDeclarations.length) * 100;

        let ctorsAdded = 0;
        let nonCtorAdded = 0;

        const p_generatedConstructors = (async (): Promise<void> => {
            for (const declaration of ctors) {
                const entry = await getWorkspaceEditArgumentsEntry(declaration, declarationDoc, targetDoc, token);
                if (entry) {
                    allArgs.set(entry.declaration, entry.args);
                } else if (token.isCancellationRequested) {
                    userCancelledOperation = true;
                    return;
                }

                progress.report({
                    message: `${++ctorsAdded + nonCtorAdded}/${functionDeclarations.length} generated`,
                    increment: increment
                });
            }
        }) ();

        for (let i = 0; i < nonCtors.length; i += 5) {
            if (token.isCancellationRequested) {
                userCancelledOperation = true;
                return;
            }

            await generateNextChunkOfNonConstructors(i);
            nonCtorAdded = Math.min(i + 5, nonCtors.length);

            progress.report({
                message: `${ctorsAdded + nonCtorAdded}/${functionDeclarations.length} generated`,
                increment: increment * (nonCtorAdded - i)
            });
        }

        await p_generatedConstructors;
    });

    if (userCancelledOperation) {
        return;
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    functionDeclarations.forEach(declaration => {
        const args = allArgs.get(declaration);
        if (args) {
            workspaceEdit.insert(...args);
        }
    });

    return workspaceEdit;
}

async function getWorkspaceEditArgumentsEntry(
    functionDeclaration: CSymbol,
    declarationDoc: SourceDocument,
    targetDoc: SourceDocument,
    token?: vscode.CancellationToken
): Promise<WorkspaceEditArgumentsEntry | undefined> {
    const p_initializers = getInitializersIfFunctionIsConstructor(functionDeclaration, token);

    const targetPos = await declarationDoc.findSmartPositionForFunctionDefinition(functionDeclaration, targetDoc);

    const functionSkeleton = await constructFunctionSkeleton(
            functionDeclaration, targetDoc, targetPos, p_initializers);
    if (functionSkeleton === undefined) {
        return;
    }

    return {
        declaration: functionDeclaration,
        args: [targetDoc.uri, targetPos, functionSkeleton]
    };
}

interface FunctionsAndTargetUri {
    functions: CSymbol[];
    targetUri: vscode.Uri;
}

async function promptUserForFunctionsAndTargetUri(
    undefinedFunctions: CSymbol[], sourceDoc: SourceDocument, matchingUri: vscode.Uri | undefined
): Promise<FunctionsAndTargetUri | undefined> {
    const p_selectedFunctions = promptUserToSelectFunctions(undefinedFunctions);

    const functionsThatRequireVisibleDefinition = undefinedFunctions.filter(declaration => {
        return util.requiresVisibleDefinition(declaration);
    });

    const selectedFunctions = await p_selectedFunctions;
    if (!selectedFunctions || selectedFunctions.length === 0) {
        return;
    }

    if (!sourceDoc.isHeader()
            || util.arraysShareAnyElement(selectedFunctions, functionsThatRequireVisibleDefinition)) {
        return {
            functions: selectedFunctions,
            targetUri: sourceDoc.uri
        };
    }

    interface DefinitionLocationItem extends vscode.QuickPickItem {
        uri?: vscode.Uri;
    }

    const locationItems: DefinitionLocationItem[] = [];

    if (matchingUri) {
        locationItems.push({
            label: `Add Definitions to "${vscode.workspace.asRelativePath(matchingUri)}"`,
            uri: matchingUri
        });
    } else {
        locationItems.push({
            label: 'Add Definitions to a new source file'
        });
    }

    locationItems.push({
        label: 'Add Definitions to this file',
        uri: sourceDoc.uri
    });

    let userTriggeredBackButton = false;

    const selectedItem = await showSingleQuickPick(locationItems, {
        ignoreFocusOut: true,
        title: 'Select which file to add the definitions to',
        buttons: [vscode.QuickInputButtons.Back],
        onDidTriggerButton: ((button, quickPick) => {
            if (button === vscode.QuickInputButtons.Back) {
                userTriggeredBackButton = true;
                quickPick.hide();
            }
        })
    });

    if (userTriggeredBackButton) {
        return promptUserForFunctionsAndTargetUri(undefinedFunctions, sourceDoc, matchingUri);
    } else if (!selectedItem) {
        return;
    }

    const targetUri = selectedItem.uri ?? await createMatchingSourceFile(sourceDoc, true);
    if (!targetUri) {
        return;
    }

    return {
        functions: selectedFunctions,
        targetUri: targetUri
    };
}

export async function promptUserToSelectFunctions(functionDeclarations: CSymbol[]): Promise<CSymbol[] | undefined> {
    interface FunctionItem extends vscode.QuickPickItem {
        declaration: CSymbol;
    }

    const functionItems: FunctionItem[] = functionDeclarations.map(declaration => {
        return {
            label: '$(symbol-function) ' + declaration.name,
            description: util.formatSignature(declaration),
            declaration: declaration
        };
    });

    const selectedItems = await showMultiQuickPick(functionItems, {
        matchOnDescription: true,
        ignoreFocusOut: true,
        title: 'Select the functions to add definitions for'
    });

    return selectedItems?.map(item => item.declaration);
}

