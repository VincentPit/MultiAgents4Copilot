package main

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

// ════════════════════════════════════════════════════════════════════
// Code block parser — extracts file paths + content from LLM output
// ════════════════════════════════════════════════════════════════════

var (
	// Matches ### `path/to/file.ts` headings before code blocks
	headingRe = regexp.MustCompile(`(?m)^#{1,4}\s+` + "`" + `([^\x60\s]+\.[a-zA-Z0-9]+)` + "`" + `\s*$`)

	// Matches fenced code blocks: ```lang\n...content...\n```
	fenceRe = regexp.MustCompile("(?s)```(\\w*)\\n(.*?)```")

	// Matches bash/shell code blocks for command extraction
	bashFenceRe = regexp.MustCompile("(?s)```(?:bash|sh|shell|zsh)\\n(.*?)```")
)

// ParseCodeBlocks extracts file blocks from LLM output.
// Expected format:
//
//	### `src/api/routes.ts`
//	```typescript
//	// file contents
//	```
func ParseCodeBlocks(llmOutput string) []CodeBlock {
	var blocks []CodeBlock

	headings := headingRe.FindAllStringSubmatchIndex(llmOutput, -1)

	for _, loc := range headings {
		if len(loc) < 4 {
			continue
		}
		filePath := llmOutput[loc[2]:loc[3]]

		// Find the next code fence after this heading
		afterHeading := llmOutput[loc[1]:]
		fenceMatch := fenceRe.FindStringSubmatch(afterHeading)
		if fenceMatch == nil {
			continue
		}

		blocks = append(blocks, CodeBlock{
			Path:     strings.TrimSpace(filePath),
			Content:  fenceMatch[2],
			Language: fenceMatch[1],
		})
	}

	return blocks
}

// ParseBashCommands extracts shell commands from LLM output.
func ParseBashCommands(llmOutput string) []string {
	var commands []string
	matches := bashFenceRe.FindAllStringSubmatch(llmOutput, -1)
	for _, m := range matches {
		lines := strings.Split(strings.TrimSpace(m[1]), "\n")
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
				commands = append(commands, trimmed)
			}
		}
	}
	return commands
}

// ════════════════════════════════════════════════════════════════════
// Domain worker — runs in its own goroutine for true parallelism
// ════════════════════════════════════════════════════════════════════

// RunDomainWorker executes the full lifecycle for a single domain:
//  1. Build a detailed prompt from the domain assignment + API spec
//  2. Request LLM code generation from the TS extension
//  3. Parse code blocks and request file writes
//  4. Request individual tests for written files
//  5. If tests fail, request a fix from the LLM and retry
func RunDomainWorker(
	bridge *Bridge,
	domain DomainAssignment,
	allDomains []DomainAssignment,
	init InitMessage,
	maxRetries int,
) WorkerResult {
	start := time.Now()
	result := WorkerResult{
		DomainID:    domain.ID,
		Domain:      domain.Domain,
		TestsPassed: false,
	}

	// ── Step 1: Build the system prompt ──
	systemPrompt := buildDomainPrompt(domain, allDomains, init)

	bridge.Log(domain.ID, "info", "📝 Building prompt and requesting code generation...")

	// ── Step 2: Request code generation from the LLM ──
	llmID := bridge.NextID(domain.ID + "-llm")
	llmResp, err := bridge.Request(LLMRequest{
		Type:         "llm_request",
		ID:           llmID,
		WorkerID:     domain.ID,
		SystemPrompt: systemPrompt,
		UserMessage:  init.Task,
	}, llmID)

	if err != nil {
		result.Errors = append(result.Errors, fmt.Sprintf("LLM request failed: %v", err))
		result.DurationMs = time.Since(start).Milliseconds()
		return result
	}
	if llmResp.Error != "" {
		result.Errors = append(result.Errors, fmt.Sprintf("LLM error: %s", llmResp.Error))
		result.DurationMs = time.Since(start).Milliseconds()
		return result
	}

	result.Code = llmResp.Content
	bridge.Log(domain.ID, "info", "✅ Code generated. Parsing file blocks...")

	// ── Step 3: Parse code blocks and write files ──
	filesWritten := writeCodeBlocks(bridge, domain.ID, llmResp.Content)
	result.FilesWritten = filesWritten

	bridge.Log(domain.ID, "info", fmt.Sprintf("📁 Wrote %d file(s): %v", len(filesWritten), filesWritten))

	if len(filesWritten) == 0 {
		bridge.Log(domain.ID, "warn", "⚠️ No file blocks found in LLM response")
		result.DurationMs = time.Since(start).Milliseconds()
		return result
	}

	// ── Step 4: Run individual tests ──
	bridge.Log(domain.ID, "info", "🧪 Running individual tests...")
	testResult := requestTests(bridge, domain.ID, filesWritten)
	result.TestsPassed = testResult.passed
	result.TestOutput = testResult.output

	// ── Step 5: Fix-retry loop if tests fail ──
	for attempt := 0; attempt < maxRetries && !result.TestsPassed; attempt++ {
		result.FixAttempts++
		bridge.Log(domain.ID, "warn", fmt.Sprintf(
			"🔧 Tests failed — requesting fix (attempt %d/%d)...", attempt+1, maxRetries,
		))

		fixPrompt := buildFixPrompt(domain, allDomains, init, testResult.output, filesWritten)
		fixID := bridge.NextID(fmt.Sprintf("%s-fix-%d", domain.ID, attempt))

		fixResp, err := bridge.Request(LLMRequest{
			Type:         "llm_request",
			ID:           fixID,
			WorkerID:     domain.ID,
			SystemPrompt: fixPrompt,
			UserMessage:  fmt.Sprintf("Fix the test failures in your files: %s", strings.Join(filesWritten, ", ")),
		}, fixID)

		if err != nil || fixResp.Error != "" {
			errMsg := "fix request failed"
			if err != nil {
				errMsg = err.Error()
			} else {
				errMsg = fixResp.Error
			}
			result.Errors = append(result.Errors, errMsg)
			break
		}

		// Apply fix
		fixedFiles := writeCodeBlocks(bridge, domain.ID, fixResp.Content)
		for _, f := range fixedFiles {
			if !contains(result.FilesWritten, f) {
				result.FilesWritten = append(result.FilesWritten, f)
			}
		}
		result.Code = fixResp.Content

		// Re-run tests
		bridge.Log(domain.ID, "info", "🧪 Re-running tests after fix...")
		testResult = requestTests(bridge, domain.ID, result.FilesWritten)
		result.TestsPassed = testResult.passed
		result.TestOutput = testResult.output
	}

	if result.TestsPassed {
		bridge.Log(domain.ID, "info", "✅ All individual tests passed!")
	} else if result.FixAttempts >= maxRetries {
		bridge.Log(domain.ID, "warn", fmt.Sprintf(
			"⚠️ Tests still failing after %d fix attempts. Passing to integrator.",
			result.FixAttempts,
		))
	}

	result.DurationMs = time.Since(start).Milliseconds()
	return result
}

// ════════════════════════════════════════════════════════════════════
// Prompt builders
// ════════════════════════════════════════════════════════════════════

func buildDomainPrompt(domain DomainAssignment, allDomains []DomainAssignment, init InitMessage) string {
	var sb strings.Builder

	sb.WriteString(`You are a Senior Engineer on a parallel feature team.
You are assigned one specific domain of the codebase. Your code runs
truly in parallel with your teammates via Go goroutines.

═══════════════════════════════════════
YOUR ASSIGNMENT
═══════════════════════════════════════
`)
	fmt.Fprintf(&sb, "  Domain:           %s\n", domain.Domain)
	fmt.Fprintf(&sb, "  Domain ID:        %s\n", domain.ID)
	fmt.Fprintf(&sb, "  Files you own:    %s\n", strings.Join(domain.FilePatterns, ", "))
	fmt.Fprintf(&sb, "  Responsibilities: %s\n", domain.Description)

	// ── API Spec (enhanced Staff Engineer output) ──
	if domain.APISpec != nil {
		sb.WriteString("\n═══════════════════════════════════════\n")
		sb.WriteString("API SPECIFICATIONS (implement EXACTLY)\n")
		sb.WriteString("═══════════════════════════════════════\n")

		if len(domain.APISpec.Endpoints) > 0 {
			sb.WriteString("\n### Endpoints:\n")
			for _, ep := range domain.APISpec.Endpoints {
				fmt.Fprintf(&sb, "  %s %s — %s\n", ep.Method, ep.Path, ep.Description)
				fmt.Fprintf(&sb, "    Request:  %s\n", ep.RequestSchema)
				fmt.Fprintf(&sb, "    Response: %s\n\n", ep.ResponseSchema)
			}
		}

		if len(domain.APISpec.Interfaces) > 0 {
			sb.WriteString("\n### Interface Contracts:\n")
			for _, iface := range domain.APISpec.Interfaces {
				fmt.Fprintf(&sb, "  %s: %s\n", iface.Name, iface.Definition)
				fmt.Fprintf(&sb, "    Export from: %s\n\n", iface.ExportedFrom)
			}
		}

		if len(domain.APISpec.Dependencies) > 0 {
			sb.WriteString("\n### Dependencies to install:\n")
			for _, dep := range domain.APISpec.Dependencies {
				fmt.Fprintf(&sb, "  - %s\n", dep)
			}
		}

		if len(domain.APISpec.TestCases) > 0 {
			sb.WriteString("\n═══════════════════════════════════════\n")
			sb.WriteString("REQUIRED TESTS (you MUST write these)\n")
			sb.WriteString("═══════════════════════════════════════\n")
			sb.WriteString("Write a test file for YOUR domain. Include at minimum:\n")
			for _, tc := range domain.APISpec.TestCases {
				fmt.Fprintf(&sb, "  ✓ %s\n", tc)
			}
			sb.WriteString("\nPut tests in a file matching your domain pattern\n")
			sb.WriteString("(e.g., src/api/__tests__/routes.test.ts).\n")
			sb.WriteString("Use the appropriate test framework (Jest, pytest, JUnit, etc.).\n")
		}
	}

	// ── Interface contracts ──
	sb.WriteString("\n═══════════════════════════════════════\n")
	sb.WriteString("INTERFACE CONTRACTS\n")
	sb.WriteString("═══════════════════════════════════════\n")
	fmt.Fprintf(&sb, "  You PROVIDE: %s\n", nonEmpty(domain.Provides, "No external contracts"))
	fmt.Fprintf(&sb, "  You CONSUME: %s\n", nonEmpty(domain.Consumes, "Nothing from other domains"))

	// ── Teammate awareness ──
	sb.WriteString("\n═══════════════════════════════════════\n")
	sb.WriteString("YOUR TEAMMATES (working in parallel)\n")
	sb.WriteString("═══════════════════════════════════════\n")

	hasTeammates := false
	for _, d := range allDomains {
		if d.ID == domain.ID {
			continue
		}
		hasTeammates = true
		fmt.Fprintf(&sb, "  • %s (%s): %s\n", d.Domain, strings.Join(d.FilePatterns, ", "), d.Description)
		fmt.Fprintf(&sb, "    Provides: %s\n", d.Provides)
	}
	if !hasTeammates {
		sb.WriteString("  (solo assignment — no teammates)\n")
	}

	// ── Scaffold context (shared foundation files already on disk) ──
	if len(init.ScaffoldFiles) > 0 {
		sb.WriteString("\n═══════════════════════════════════════\n")
		sb.WriteString("SHARED SCAFFOLD (already on disk — DO NOT recreate)\n")
		sb.WriteString("═══════════════════════════════════════\n")
		sb.WriteString("The Staff Engineer already set up a shared foundation.\n")
		sb.WriteString("These files are already written to disk:\n\n")
		for _, f := range init.ScaffoldFiles {
			fmt.Fprintf(&sb, "  📄 %s\n", f)
		}
		sb.WriteString("\nIMPORT from these files — do NOT redefine the types/interfaces they contain.\n")
		if init.ScaffoldCode != "" {
			code := init.ScaffoldCode
			if len(code) > 4000 {
				code = code[:4000] + "\n[… truncated]"
			}
			fmt.Fprintf(&sb, "\nScaffold contents (for reference):\n%s\n", code)
		}
	}

	// ── Rules ──
	sb.WriteString(`
═══════════════════════════════════════
CRITICAL RULES
═══════════════════════════════════════
1. ONLY create/modify files within your file patterns.
2. When you CONSUME an interface from another domain, import it as if it
   already exists — your teammate IS creating it right now in parallel.
3. When you PROVIDE an interface, export it with the EXACT signature
   specified in the contract.
4. Write clean, production-quality, well-typed, well-documented code.
5. Do NOT duplicate work that belongs to another domain.
6. Include comprehensive JSDoc/docstrings at export boundaries.
7. WRITE INDIVIDUAL TESTS for your domain's code.
   Each domain must have its own test file(s).

═══════════════════════════════════════
FILE FORMAT (mandatory)
═══════════════════════════════════════
For EVERY file you create or modify:

### ` + "`" + `path/to/file.ts` + "`" + `
` + "```" + `typescript
// full file contents here
` + "```" + `

Rules:
- Use RELATIVE paths from project root.
- Include COMPLETE file contents — not diffs.
- Use correct language tags on code fences.
- If dependencies need installing, include a ` + "```" + `bash block.

SELF-PROTECTION — NEVER modify files belonging to the Multi-Agent Copilot
extension itself (src/agents/, src/graph/, src/utils/, src/security/,
src/types/, src/extension.ts).
`)

	// ── Plan context ──
	if len(init.Plan) > 0 {
		sb.WriteString("\n## Plan\n")
		for _, step := range init.Plan {
			fmt.Fprintf(&sb, "%s\n", step)
		}
	}

	return sb.String()
}

func buildFixPrompt(domain DomainAssignment, allDomains []DomainAssignment, init InitMessage, testOutput string, files []string) string {
	base := buildDomainPrompt(domain, allDomains, init)

	base += fmt.Sprintf(`

## ❌ TESTS FAILED — FIX YOUR CODE
Your code failed the individual test suite. Here are the test results:

%s

Files you wrote: %s

Fix ALL issues. Rewrite ONLY the files that have errors.
Include COMPLETE fixed file contents using ### `+"`"+`path`+"`"+` format.
Do NOT re-output files that are already correct.
`, testOutput, strings.Join(files, ", "))

	return base
}

// ════════════════════════════════════════════════════════════════════
// File writing and test execution helpers
// ════════════════════════════════════════════════════════════════════

type testResult struct {
	passed bool
	output string
}

func writeCodeBlocks(bridge *Bridge, workerID string, llmOutput string) []string {
	blocks := ParseCodeBlocks(llmOutput)
	var written []string

	for _, block := range blocks {
		id := bridge.NextID(workerID + "-write")

		bridge.Log(workerID, "code", fmt.Sprintf("📄 Writing: %s (%s)", block.Path, block.Language))

		resp, err := bridge.Request(FileWriteRequest{
			Type:     "file_write",
			ID:       id,
			WorkerID: workerID,
			FilePath: block.Path,
			Content:  block.Content,
			Language: block.Language,
		}, id)

		if err != nil {
			bridge.Log(workerID, "error", fmt.Sprintf("File write failed for %s: %v", block.Path, err))
			continue
		}
		if resp.Error != "" {
			bridge.Log(workerID, "error", fmt.Sprintf("File write rejected for %s: %s", block.Path, resp.Error))
			continue
		}

		written = append(written, block.Path)
	}

	return written
}

func requestTests(bridge *Bridge, workerID string, files []string) testResult {
	if len(files) == 0 {
		return testResult{passed: true, output: "no files to test"}
	}

	id := bridge.NextID(workerID + "-test")
	resp, err := bridge.Request(TestRunRequest{
		Type:     "test_request",
		ID:       id,
		WorkerID: workerID,
		Files:    files,
	}, id)

	if err != nil {
		return testResult{passed: false, output: fmt.Sprintf("test request failed: %v", err)}
	}

	return testResult{
		passed: resp.Passed,
		output: resp.Output,
	}
}

// ════════════════════════════════════════════════════════════════════
// Utility helpers
// ════════════════════════════════════════════════════════════════════

func nonEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}
