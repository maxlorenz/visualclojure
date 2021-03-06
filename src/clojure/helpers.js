const vscode = require('vscode');
const nreplClient = require('../nrepl/client');
const nreplMsg = require('../nrepl/message');
const SESSION_TYPE = require('../nrepl/session_type');

function getNamespace(text) {
    let match = text.match(/^[\s\t]*\((?:[\s\t\n]*(?:in-){0,1}ns)[\s\t\n]+'?([\w.\-\/]+)[\s\S]*\)[\s\S]*/);
    return match ? match[1] : 'user';
};

function getActualWord(document, position, selected, word) {
    if (selected === undefined) {
        let selectedChar = document.lineAt(position.line).text.slice(position.character, position.character + 1),
            isFn = document.lineAt(position.line).text.slice(position.character - 1, position.character) === "(";
        if (this.specialWords.indexOf(selectedChar) !== -1 && isFn) {
            return selectedChar;
        } else {
            console.error("Unsupported selectedChar '" + selectedChar + "'");
            return word;
        }
    } else {
        return word;
    }
};

//using algorithm from: http://stackoverflow.com/questions/15717436/js-regex-to-match-everything-inside-braces-including-nested-braces-i-want/27088184#27088184
function getContentToNextBracket(block) {
    var currPos = 0,
        openBrackets = 0,
        stillSearching = true,
        waitForChar = false;

    while (stillSearching && currPos <= block.length) {
        var currChar = block.charAt(currPos);
        if (!waitForChar) {
            switch (currChar) {
                case '(':
                    openBrackets++;
                    break;
                case ')':
                    openBrackets--;
                    break;
                case '"':
                case "'":
                    waitForChar = currChar;
                    break;
                case '/':
                    var nextChar = block.charAt(currPos + 1);
                    if (nextChar === '/') {
                        waitForChar = '\n';
                    } else if (nextChar === '*') {
                        waitForChar = '*/';
                    }
                    break;
            }
        } else {
            if (currChar === waitForChar) {
                if (waitForChar === '"' || waitForChar === "'") {
                    block.charAt(currPos - 1) !== '\\' && (waitForChar = false);
                } else {
                    waitForChar = false;
                }
            } else if (currChar === '*') {
                block.charAt(currPos + 1) === '/' && (waitForChar = false);
            }
        }
        currPos++
        if (openBrackets === 0) {
            stillSearching = false;
        }
    }
    return [currPos, block.substr(0, currPos)];
};

function getContentToPreviousBracket(block) {
    var currPos = (block.length - 1),
        openBrackets = 0,
        stillSearching = true,
        waitForChar = false;

    while (stillSearching && currPos >= 0) {
        var currChar = block.charAt(currPos);
        if (!waitForChar) {
            switch (currChar) {
                case '(':
                    openBrackets--;
                    break;
                case ')':
                    openBrackets++;
                    break;
                case '"':
                case "'":
                    waitForChar = currChar;
                    break;
                case '/':
                    var nextChar = block.charAt(currPos + 1);
                    if (nextChar === '/') {
                        waitForChar = '\n';
                    } else if (nextChar === '*') {
                        waitForChar = '*/';
                    }
                    break;
            }
        } else {
            if (currChar === waitForChar) {
                if (waitForChar === '"' || waitForChar === "'") {
                    block.charAt(currPos - 1) !== '\\' && (waitForChar = false);
                } else {
                    waitForChar = false;
                }
            } else if (currChar === '*') {
                block.charAt(currPos + 1) === '/' && (waitForChar = false);
            }
        }
        currPos--
        if (openBrackets === 0) {
            stillSearching = false;
        }
    }
    return [currPos, block.substr(currPos + 1, block.length)];
};

function handleException(state, exceptions, isSelection = false) {
    let errorHasBeenMarked = false,
        editor = vscode.window.activeTextEditor,
        filetypeIndex = (editor.document.fileName.lastIndexOf('.') + 1),
        filetype = editor.document.fileName.substr(filetypeIndex, editor.document.fileName.length);
    state.diagnosticCollection.clear();
    let exClient = nreplClient.create({
        host: state.hostname,
        port: state.port
    }).once('connect', function () {
        let msg = nreplMsg.stacktrace(state.session[filetype]),
            errLine = null,
            errChar = null,
            errFileUri = editor.document.uri;

        exClient.send(msg, (results) => {
            if (results.length === 2 && results[0].hasOwnProperty('status') && results[0].status[0] === "no-error" && results[1].status[0] === "done") {
                let errorMsg = "Error when evaluating this expression..";
                for(let r = 0; r < exceptions.length; r++) {
                    let result = exceptions[r];
                    if(result.hasOwnProperty('err')
                      && result.err.indexOf("line") !== -1 
                      && result.err.indexOf("column") !== -1) {
                        errorHasBeenMarked = true;  
                        let errorParts = result.err;
                        if (errorParts.indexOf("starting at line") !== -1 && errorParts.indexOf("and column") !== -1) {
                            errorParts = result.err.split(' ');
                            errorMsg = result.err.substring(result.err.indexOf("clojure.lang.ExceptionInfo:") + 27, result.err.indexOf("starting"));
                        } else if (errorParts.indexOf("at line") !== -1 && errorParts.indexOf("and column") === -1) {
                            errorParts = result.err.substring(result.err.indexOf('{'), result.err.indexOf('}')).replace(/:/g, '').replace(/,/g, '').replace(/\r\n/, '').replace(/}/, '').split(' ');
                            errorMsg = result.err.substring(result.err.indexOf("clojure.lang.ExceptionInfo:") + 27, result.err.indexOf("at line"));
                        } else if (errorParts.indexOf(":line") !== -1 && errorParts.indexOf(":column") !== -1) {
                            errorParts = result.err.substring(result.err.indexOf('{'), result.err.indexOf('}')).replace(/:/g, '').replace(/,/g, '').replace(/\r\n/, '').replace(/}/, '').split(' ');
                            errorMsg = result.err.substring(result.err.indexOf("clojure.lang.ExceptionInfo:") + 27, result.err.indexOf("{"));
                        }
                        errLine = parseInt(errorParts[errorParts.indexOf("line") + 1], 10) - 1;
                        errChar = parseInt(errorParts[errorParts.indexOf("column") + 1], 10) - 1;
                    }
                    if (result.hasOwnProperty('err') && result.err.indexOf("WARNING:") !== -1) {
                        errorMsg += "\n" + result.err.substring(result.err.indexOf("WARNING:"), result.err.indexOf("at line"));
                    }
                    if (result.hasOwnProperty('err') && result.err.indexOf("TypeError:") !== -1) {
                        errorMsg += "\n" + result.err;
                    }

                }
                if(!errorHasBeenMarked) {
                    state.diagnosticCollection.set(editor.document.uri, 
                                                [new vscode.Diagnostic(new vscode.Range(editor.selection.start.line, 
                                                editor.selection.start.character, 
                                                editor.selection.start.line, 
                                                editor.document.lineAt(editor.selection.start.line).text.length),
                                errorMsg, vscode.DiagnosticSeverity.Error)]);
                } else if(errLine >= 0  && errChar >= 0) {
                    if(isSelection) {
                        errLine = errLine + editor.selection.start.line;
                        errChar = errChar + editor.selection.start.character;
                    }
                    let errPos = new vscode.Position(errLine, errChar),
                        errLineLength = editor.document.lineAt(errLine).text.length;
                    
                    editor.selection = new vscode.Selection(errPos, errPos);
                    state.diagnosticCollection.set(errFileUri, [new vscode.Diagnostic(new vscode.Range(errLine, errChar, errLine, errLineLength),
                        errorMsg, vscode.DiagnosticSeverity.Error)]);
                }
            } else {
                for(let r = 0; r < results.length; r++) {
                    let result = results[r],
                        errLine = result.line - 1,
                        errChar = result.column - 1,
                        errFile = result.file,
                        errFileUri = null,
                        errMsg = result.message,
                        editor = vscode.window.activeTextEditor;

                    if (errFile) {
                        errFileUri = vscode.Uri.file(errFile);
                    } else {
                        errFileUri = editor.document.uri;
                    }

                    if(errLine >= 0  && errChar >= 0) {
                        if(!editor.selection.isEmpty) {
                            errLine = errLine + editor.selection.start.line;
                            errChar = errChar + editor.selection.start.character;
                        }

                        let errPos = new vscode.Position(errLine, errChar);
                        editor.selection = new vscode.Selection(errPos, errPos);
                        let errLineLength = editor.document.lineAt(errLine).text.length;

                        state.diagnosticCollection.set(errFileUri, [new vscode.Diagnostic(new vscode.Range(errLine, errChar, errLine, errLineLength),
                            errMsg, vscode.DiagnosticSeverity.Error)]);
                    }
                }
            }
            exClient.end();
        });
    });
};

function updateStatusbar(state) {
    if (state.hostname) {
        state.statusbar_connection.text = "nrepl://" + state.hostname + ":" + state.port;
    } else {
        state.statusbar_connection.text = "nrepl - no connection";
    }
    state.statusbar_type.text = state.session_type.statusbar;
    switch (state.session_type.id) {
        case SESSION_TYPE.CLJ.id:
            state.statusbar_type.color = "rgb(144,180,254)";
            break;
        case SESSION_TYPE.CLJS.id:
            state.statusbar_type.color = "rgb(145,220,71)";
            break;
        default:
            state.statusbar_type.color = "rgb(192,192,192)";
            break;
    }
    state.statusbar_connection.show();
    state.statusbar_type.show();
};


module.exports = {
    getActualWord,
    getNamespace,
    handleException,
    getContentToNextBracket,
    getContentToPreviousBracket,
    updateStatusbar
};
