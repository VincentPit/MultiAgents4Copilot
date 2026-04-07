// Go Worker — True parallel domain coder execution via goroutines.
//
// Spawned by the VS Code extension as a child process. Receives domain
// assignments, spawns one goroutine per domain, and communicates with
// the extension via newline-delimited JSON over stdin/stdout.
//
// Each goroutine runs truly in parallel via GOMAXPROCS, unlike Node.js's
// single-threaded event loop with Promise.allSettled.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// ════════════════════════════════════════════════════════════════════
// Bridge — thread-safe bidirectional IPC with the TS extension
// ════════════════════════════════════════════════════════════════════

// Bridge handles multiplexed JSON-RPC communication with the extension.
// Multiple goroutines can concurrently send requests and block until
// their individual responses arrive via the pending channel map.
type Bridge struct {
	mu        sync.Mutex
	encoder   *json.Encoder
	pending   map[string]chan *IncomingMessage
	pendingMu sync.Mutex
	reqID     atomic.Int64
	closed    atomic.Bool
}

func NewBridge() *Bridge {
	return &Bridge{
		encoder: json.NewEncoder(os.Stdout),
		pending: make(map[string]chan *IncomingMessage),
	}
}

// Send writes a JSON message to stdout (thread-safe, mutex-protected).
func (b *Bridge) Send(msg interface{}) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.encoder.Encode(msg)
}

// NextID generates a unique request ID with the given prefix.
func (b *Bridge) NextID(prefix string) string {
	n := b.reqID.Add(1)
	return fmt.Sprintf("%s-%d", prefix, n)
}

// Request sends a message and blocks until a response with the matching ID arrives.
// This is the core mechanism for goroutine-safe request/response over IPC.
func (b *Bridge) Request(msg interface{}, id string) (*IncomingMessage, error) {
	ch := make(chan *IncomingMessage, 1)

	b.pendingMu.Lock()
	b.pending[id] = ch
	b.pendingMu.Unlock()

	if err := b.Send(msg); err != nil {
		b.pendingMu.Lock()
		delete(b.pending, id)
		b.pendingMu.Unlock()
		return nil, fmt.Errorf("send failed: %w", err)
	}

	resp, ok := <-ch
	if !ok || resp == nil {
		return nil, fmt.Errorf("bridge closed while waiting for %s", id)
	}
	return resp, nil
}

// Log sends a fire-and-forget log message to the per-worker output channel.
func (b *Bridge) Log(workerID, level, message string) {
	_ = b.Send(LogMessage{
		Type:     "log",
		WorkerID: workerID,
		Level:    level,
		Message:  message,
	})
}

// ReadLoop reads JSON messages from stdin and dispatches them to the
// correct pending request channel. Runs until stdin closes or is cancelled.
// Must be called in a dedicated goroutine.
func (b *Bridge) ReadLoop(initCh chan<- *InitMessage) {
	scanner := bufio.NewScanner(os.Stdin)
	buf := make([]byte, 0, 10*1024*1024)
	scanner.Buffer(buf, 10*1024*1024) // 10 MB buffer for large LLM responses

	for scanner.Scan() {
		if b.closed.Load() {
			return
		}

		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		// First, check if this is the init message
		var peek struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(line, &peek); err != nil {
			continue
		}

		if peek.Type == "init" && initCh != nil {
			var init InitMessage
			if err := json.Unmarshal(line, &init); err != nil {
				b.Log("bridge", "error", fmt.Sprintf("Failed to parse init: %v", err))
				continue
			}
			initCh <- &init
			initCh = nil // Only accept one init message
			continue
		}

		// Regular response message — dispatch to pending request
		var msg IncomingMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			b.Log("bridge", "error", fmt.Sprintf("Failed to parse message: %v", err))
			continue
		}

		if msg.ID != "" {
			b.pendingMu.Lock()
			if ch, ok := b.pending[msg.ID]; ok {
				ch <- &msg
			}
			b.pendingMu.Unlock()
		}
	}

	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "stdin scanner error: %v\n", err)
	}

	b.closed.Store(true)

	// Unblock any goroutines waiting for responses
	b.pendingMu.Lock()
	for id, ch := range b.pending {
		close(ch)
		delete(b.pending, id)
	}
	b.pendingMu.Unlock()
}

// ════════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════════

func main() {
	// Use all CPU cores for true parallel goroutine execution
	runtime.GOMAXPROCS(runtime.NumCPU())

	bridge := NewBridge()

	// Channel for receiving the init message from the read loop
	initCh := make(chan *InitMessage, 1)

	// Start the stdin read loop in a background goroutine
	go bridge.ReadLoop(initCh)

	// Signal readiness to the TS extension
	_ = bridge.Send(map[string]string{"type": "ready"})

	bridge.Log("main", "info", fmt.Sprintf(
		"Go worker started (pid=%d, cpus=%d, GOMAXPROCS=%d)",
		os.Getpid(), runtime.NumCPU(), runtime.GOMAXPROCS(0),
	))

	// Wait for init message from the TS extension
	initMsg, ok := <-initCh
	if !ok || initMsg == nil {
		fmt.Fprintf(os.Stderr, "No init message received\n")
		os.Exit(1)
	}

	domains := initMsg.Domains
	maxRetries := initMsg.MaxFixRetries
	if maxRetries <= 0 {
		maxRetries = 2
	}

	bridge.Log("main", "info", fmt.Sprintf(
		"Received %d domain assignment(s). Launching goroutines...",
		len(domains),
	))

	// ── Spawn one goroutine per domain for true parallel execution ──
	startAll := time.Now()
	results := make([]WorkerResult, len(domains))
	var wg sync.WaitGroup

	for i, domain := range domains {
		wg.Add(1)
		go func(idx int, d DomainAssignment) {
			defer wg.Done()

			bridge.Log(d.ID, "info", fmt.Sprintf(
				"🚀 [goroutine %d/%d] Domain: %s — files: %v",
				idx+1, len(domains), d.Domain, d.FilePatterns,
			))

			result := RunDomainWorker(bridge, d, domains, *initMsg, maxRetries)
			results[idx] = result

			// Notify the TS extension that this worker is done
			_ = bridge.Send(WorkerDoneMessage{
				Type:     "worker_done",
				WorkerID: d.ID,
				Result:   result,
			})

			status := "✅"
			if len(result.Errors) > 0 {
				status = "⚠️"
			}
			bridge.Log(d.ID, "info", fmt.Sprintf(
				"%s Completed in %dms — %d file(s), tests=%v, fixes=%d",
				status, result.DurationMs, len(result.FilesWritten),
				result.TestsPassed, result.FixAttempts,
			))
		}(i, domain)
	}

	// Wait for ALL goroutines to complete
	wg.Wait()

	totalMs := time.Since(startAll).Milliseconds()
	bridge.Log("main", "info", fmt.Sprintf(
		"All %d workers completed in %dms wall-clock time",
		len(domains), totalMs,
	))

	// Send final aggregated results
	_ = bridge.Send(AllDoneMessage{
		Type:    "all_done",
		Results: results,
	})
}
