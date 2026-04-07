package main

// DomainAssignment describes one engineer's scope of work.
type DomainAssignment struct {
	ID           string   `json:"id"`
	Domain       string   `json:"domain"`
	Description  string   `json:"description"`
	FilePatterns []string `json:"filePatterns"`
	Provides     string   `json:"provides"`
	Consumes     string   `json:"consumes"`
	APISpec      *APISpec `json:"apiSpec,omitempty"`
}

// APISpec contains detailed specifications for a domain assignment.
type APISpec struct {
	Endpoints    []Endpoint     `json:"endpoints,omitempty"`
	Interfaces   []InterfaceDef `json:"interfaces,omitempty"`
	TestCases    []string       `json:"testCases,omitempty"`
	Dependencies []string       `json:"dependencies,omitempty"`
}

// Endpoint describes a single API endpoint to implement.
type Endpoint struct {
	Method         string `json:"method"`
	Path           string `json:"path"`
	RequestSchema  string `json:"requestSchema"`
	ResponseSchema string `json:"responseSchema"`
	Description    string `json:"description"`
}

// InterfaceDef describes an interface/type contract between domains.
type InterfaceDef struct {
	Name         string `json:"name"`
	Definition   string `json:"definition"`
	ExportedFrom string `json:"exportedFrom"`
}

// InitMessage is the first message sent by the TS extension.
type InitMessage struct {
	Type          string             `json:"type"`
	Domains       []DomainAssignment `json:"domains"`
	Task          string             `json:"task"`
	WorkspaceRoot string             `json:"workspaceRoot"`
	Plan          []string           `json:"plan,omitempty"`
	MaxFixRetries int                `json:"maxFixRetries"`
	ScaffoldFiles []string           `json:"scaffoldFiles,omitempty"`
	ScaffoldCode  string             `json:"scaffoldCode,omitempty"`
}

// IncomingMessage is the generic envelope for messages from TS to Go.
type IncomingMessage struct {
	Type    string `json:"type"`
	ID      string `json:"id,omitempty"`
	Content string `json:"content,omitempty"`
	Passed  bool   `json:"passed,omitempty"`
	Output  string `json:"output,omitempty"`
	Success bool   `json:"success,omitempty"`
	Error   string `json:"error,omitempty"`
}

// LLMRequest asks the TS extension to call the vscode.lm API.
type LLMRequest struct {
	Type         string `json:"type"`
	ID           string `json:"id"`
	WorkerID     string `json:"workerId"`
	SystemPrompt string `json:"systemPrompt"`
	UserMessage  string `json:"userMessage"`
}

// FileWriteRequest asks the TS extension to write a file.
type FileWriteRequest struct {
	Type     string `json:"type"`
	ID       string `json:"id"`
	WorkerID string `json:"workerId"`
	FilePath string `json:"filePath"`
	Content  string `json:"content"`
	Language string `json:"language"`
}

// TestRunRequest asks the TS extension to run tests for files.
type TestRunRequest struct {
	Type     string   `json:"type"`
	ID       string   `json:"id"`
	WorkerID string   `json:"workerId"`
	Files    []string `json:"files"`
}

// LogMessage sends real-time status to a per-worker output channel.
type LogMessage struct {
	Type     string `json:"type"`
	WorkerID string `json:"workerId"`
	Level    string `json:"level"`
	Message  string `json:"message"`
}

// WorkerDoneMessage signals that one domain worker finished.
type WorkerDoneMessage struct {
	Type     string       `json:"type"`
	WorkerID string       `json:"workerId"`
	Result   WorkerResult `json:"result"`
}

// WorkerResult contains the output of a single domain worker.
type WorkerResult struct {
	DomainID     string   `json:"domainId"`
	Domain       string   `json:"domain"`
	FilesWritten []string `json:"filesWritten"`
	TestsPassed  bool     `json:"testsPassed"`
	TestOutput   string   `json:"testOutput"`
	Errors       []string `json:"errors"`
	DurationMs   int64    `json:"durationMs"`
	FixAttempts  int      `json:"fixAttempts"`
	Code         string   `json:"code"`
}

// AllDoneMessage signals that all domain workers finished.
type AllDoneMessage struct {
	Type    string         `json:"type"`
	Results []WorkerResult `json:"results"`
}

// CodeBlock represents a single file extracted from LLM output.
type CodeBlock struct {
	Path     string
	Content  string
	Language string
}
