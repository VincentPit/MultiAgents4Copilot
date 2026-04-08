/**
 * Manual mock for the `vscode` module.
 *
 * Jest can't load the real VS Code API outside the extension host,
 * so we stub the parts our source code actually imports.
 *
 * Covers: chat, lm, window, workspace, commands, extensions, authentication
 * Classes: LanguageModelChatMessage, LanguageModelError, MarkdownString,
 *          ThemeIcon, Uri, CancellationTokenSource
 * Enums:   ChatResultFeedbackKind, LanguageModelChatMessageRole, FileType
 */

// ── Uri ──────────────────────────────────────────────────────────────

const Uri = {
  file: (p: string) => ({ fsPath: p, scheme: "file", path: p, toString: () => p }),
  parse: (s: string) => ({ fsPath: s, scheme: s.startsWith("file") ? "file" : "https", path: s, toString: () => s }),
  joinPath: (base: any, ...segments: string[]) => {
    const joined = [base.fsPath ?? base.path, ...segments].join("/");
    return { fsPath: joined, scheme: "file", path: joined, toString: () => joined };
  },
};

// ── Workspace ────────────────────────────────────────────────────────

const workspace = {
  workspaceFolders: [{ uri: Uri.file("/mock-workspace"), name: "mock", index: 0 }],
  fs: {
    stat: jest.fn().mockRejectedValue(new Error("not found")),
    readFile: jest.fn().mockRejectedValue(new Error("not found")),
    writeFile: jest.fn().mockResolvedValue(undefined),
    readDirectory: jest.fn().mockResolvedValue([]),
  },
  findFiles: jest.fn().mockResolvedValue([]),
  openTextDocument: jest.fn().mockResolvedValue({ getText: () => "" }),
  asRelativePath: (uri: any) => (typeof uri === "string" ? uri : uri.fsPath ?? uri.path),
  registerTextDocumentContentProvider: jest.fn().mockReturnValue({ dispose: jest.fn() }),
};

// ── Window ───────────────────────────────────────────────────────────

const window = {
  showWarningMessage: jest.fn().mockResolvedValue("Apply Changes"),
  showInformationMessage: jest.fn().mockResolvedValue(undefined),
  showErrorMessage: jest.fn().mockResolvedValue(undefined),
  showTextDocument: jest.fn().mockResolvedValue(undefined),
  showQuickPick: jest.fn().mockResolvedValue(undefined),
  createTerminal: jest.fn().mockReturnValue({
    show: jest.fn(),
    sendText: jest.fn(),
    dispose: jest.fn(),
  }),
  createOutputChannel: jest.fn().mockReturnValue({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    show: jest.fn(),
    dispose: jest.fn(),
    appendLine: jest.fn(),
    clear: jest.fn(),
  }),
  createWebviewPanel: jest.fn().mockImplementation(() => ({
    webview: {
      html: "",
      postMessage: jest.fn().mockResolvedValue(true),
    },
    onDidDispose: jest.fn(),
    dispose: jest.fn(),
    visible: true,
  })),
  activeTextEditor: undefined,
  tabGroups: { all: [] },
};

// ── Language model stubs ─────────────────────────────────────────────

class LanguageModelChatMessage {
  role: string;
  content: string;
  constructor(role: string, content: string) {
    this.role = role;
    this.content = content;
  }
  static User(content: string) {
    return new LanguageModelChatMessage("user", content);
  }
  static Assistant(content: string) {
    return new LanguageModelChatMessage("assistant", content);
  }
}

class LanguageModelError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
  static NotFound = { name: "NotFound" };
  static Blocked = { name: "Blocked" };
}

const lm = {
  selectChatModels: jest.fn().mockResolvedValue([
    {
      name: "mock-model",
      maxInputTokens: 200_000,
      countTokens: jest.fn().mockImplementation(async (text: any) => {
        const str = typeof text === "string" ? text : (text?.content ?? JSON.stringify(text));
        return Math.ceil(str.length / 4);
      }),
      sendRequest: jest.fn().mockResolvedValue({
        text: (async function* () { yield "mock response"; })(),
      }),
    },
  ]),
};

// ── Authentication ───────────────────────────────────────────────────

const authentication = {
  getSession: jest.fn().mockResolvedValue(null),
};

// ── Commands & Extensions ────────────────────────────────────────────

const commands = {
  registerCommand: jest.fn(),
  executeCommand: jest.fn(),
};

const extensions = {
  getExtension: jest.fn(),
};

// ── Enums ────────────────────────────────────────────────────────────

const ChatResultFeedbackKind = {
  Unhelpful: 0,
  Helpful: 1,
};

const LanguageModelChatMessageRole = {
  User: 1,
  Assistant: 2,
};

// ── Misc ─────────────────────────────────────────────────────────────

const FileType = {
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
};

const ViewColumn = {
  Active: -1,
  Beside: -2,
  One: 1,
  Two: 2,
  Three: 3,
};

class ThemeIcon {
  id: string;
  constructor(id: string) { this.id = id; }
}

const chat = {
  createChatParticipant: jest.fn().mockReturnValue({
    iconPath: undefined,
    followupProvider: undefined,
    dispose: jest.fn(),
  }),
};

class CancellationTokenSource {
  token = { isCancellationRequested: false, onCancellationRequested: jest.fn() };
  cancel() { (this.token as any).isCancellationRequested = true; }
  dispose() {}
}

class MarkdownString {
  value: string;
  isTrusted?: boolean | { enabledCommands: string[] };
  supportThemeIcons?: boolean;
  constructor(value = "", supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }
  appendMarkdown(value: string) { this.value += value; return this; }
  appendText(value: string) { this.value += value; return this; }
}

// ── ChatResponseStream mock ──────────────────────────────────────────

function createMockStream() {
  return {
    markdown: jest.fn(),
    progress: jest.fn(),
    reference: jest.fn(),
    button: jest.fn(),
    anchor: jest.fn(),
  };
}

// ── Exports ──────────────────────────────────────────────────────────

module.exports = {
  Uri,
  workspace,
  window,
  lm,
  authentication,
  commands,
  extensions,
  FileType,
  ViewColumn,
  ThemeIcon,
  LanguageModelChatMessage,
  LanguageModelError,
  LanguageModelChatMessageRole,
  ChatResultFeedbackKind,
  MarkdownString,
  CancellationTokenSource,
  chat,
  // Helper for tests to create mock streams
  __createMockStream: createMockStream,
};
