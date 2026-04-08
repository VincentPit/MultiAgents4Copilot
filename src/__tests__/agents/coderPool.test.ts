/**
 * Tests for src/agents/coderPool.ts — domain decomposition & parallel coder pool.
 */

import { parseDomainAssignments, Semaphore, LLM_CONCURRENCY, MAX_DOMAINS, formatMs } from "../../agents/coderPool";
import type { DomainAssignment } from "../../graph/state";

describe("parseDomainAssignments", () => {
  it("parses a valid JSON array from a ```json fence", () => {
    const raw = `Here are the domains:

\`\`\`json
[
  {
    "id": "backend-api",
    "domain": "Backend API",
    "description": "REST routes and middleware",
    "filePatterns": ["src/api/**", "src/routes/**"],
    "provides": "GET /users, POST /users",
    "consumes": "UserService from data-layer"
  },
  {
    "id": "data-layer",
    "domain": "Data Layer",
    "description": "Database models and queries",
    "filePatterns": ["src/models/**", "src/db/**"],
    "provides": "UserService, DatabaseClient",
    "consumes": "nothing"
  }
]
\`\`\``;

    const result = parseDomainAssignments(raw);
    expect(result).toHaveLength(2);

    expect(result[0].id).toBe("backend-api");
    expect(result[0].domain).toBe("Backend API");
    expect(result[0].filePatterns).toEqual(["src/api/**", "src/routes/**"]);
    expect(result[0].provides).toBe("GET /users, POST /users");
    expect(result[0].consumes).toBe("UserService from data-layer");

    expect(result[1].id).toBe("data-layer");
    expect(result[1].domain).toBe("Data Layer");
  });

  it("parses bare JSON without code fence", () => {
    const raw = `[{"id":"ui","domain":"Frontend","description":"React components","filePatterns":["src/components/**"],"provides":"App component","consumes":"API client"}]`;

    const result = parseDomainAssignments(raw);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ui");
    expect(result[0].domain).toBe("Frontend");
  });

  it("handles a single domain assignment", () => {
    const raw = `\`\`\`json
[
  {
    "id": "full-stack",
    "domain": "Full Stack",
    "description": "Complete implementation",
    "filePatterns": ["src/**"],
    "provides": "Everything",
    "consumes": "Nothing"
  }
]
\`\`\``;

    const result = parseDomainAssignments(raw);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("full-stack");
  });

  it("returns empty array for invalid JSON", () => {
    const result = parseDomainAssignments("this is not json at all");
    expect(result).toEqual([]);
  });

  it("returns empty array for non-array JSON", () => {
    const result = parseDomainAssignments('{"id": "backend"}');
    expect(result).toEqual([]);
  });

  it("filters out entries missing required id field", () => {
    const raw = `[{"domain":"Valid","id":"ok","description":"d","filePatterns":[],"provides":"x","consumes":"y"},{"domain":"Invalid","description":"d"}]`;
    const result = parseDomainAssignments(raw);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ok");
  });

  it("handles missing optional fields with defaults", () => {
    const raw = `[{"id":"minimal","domain":"Minimal"}]`;
    const result = parseDomainAssignments(raw);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("");
    expect(result[0].filePatterns).toEqual([]);
    expect(result[0].provides).toBe("");
    expect(result[0].consumes).toBe("");
  });

  it("trims whitespace from all fields", () => {
    const raw = `[{"id":"  backend  ","domain":"  Backend API  ","description":"  REST  ","filePatterns":["src/**"],"provides":"  API  ","consumes":"  DB  "}]`;
    const result = parseDomainAssignments(raw);
    expect(result[0].id).toBe("backend");
    expect(result[0].domain).toBe("Backend API");
    expect(result[0].description).toBe("REST");
    expect(result[0].provides).toBe("API");
    expect(result[0].consumes).toBe("DB");
  });

  it("handles multiple domains for big corp projects", () => {
    const raw = `\`\`\`json
[
  {"id": "auth", "domain": "Auth Service", "description": "Authentication", "filePatterns": ["src/auth/**"], "provides": "AuthMiddleware", "consumes": "UserModel from data"},
  {"id": "data", "domain": "Data Layer", "description": "Database", "filePatterns": ["src/db/**"], "provides": "UserModel", "consumes": "nothing"},
  {"id": "api", "domain": "API Routes", "description": "REST API", "filePatterns": ["src/api/**"], "provides": "Router", "consumes": "AuthMiddleware from auth"},
  {"id": "frontend", "domain": "Frontend", "description": "React UI", "filePatterns": ["src/ui/**"], "provides": "App", "consumes": "API client"},
  {"id": "tests", "domain": "Test Suite", "description": "Testing", "filePatterns": ["src/__tests__/**"], "provides": "Test coverage", "consumes": "All modules"}
]
\`\`\``;

    const result = parseDomainAssignments(raw);
    expect(result).toHaveLength(5);
    expect(result.map(d => d.id)).toEqual(["auth", "data", "api", "frontend", "tests"]);
  });
});

describe("DomainAssignment type", () => {
  it("satisfies the interface contract", () => {
    const assignment: DomainAssignment = {
      id: "backend-api",
      domain: "Backend API",
      description: "REST routes, middleware, controllers",
      filePatterns: ["src/api/**", "src/middleware/**"],
      provides: "UserController, AuthMiddleware",
      consumes: "UserService from data-layer",
    };

    expect(assignment.id).toBe("backend-api");
    expect(assignment.filePatterns).toHaveLength(2);
    expect(assignment.provides).toContain("UserController");
    expect(assignment.consumes).toContain("data-layer");
  });
});

describe("Semaphore", () => {
  it("allows up to max concurrent acquisitions", async () => {
    const sem = new Semaphore(2);
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 5 }, async (_, i) => {
      await sem.acquire();
      running++;
      maxRunning = Math.max(maxRunning, running);
      // Simulate work
      await new Promise(r => setTimeout(r, 10));
      running--;
      sem.release();
    });

    await Promise.all(tasks);
    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it("processes all tasks even with limited concurrency", async () => {
    const sem = new Semaphore(1);
    const completed: number[] = [];

    const tasks = Array.from({ length: 4 }, async (_, i) => {
      await sem.acquire();
      completed.push(i);
      sem.release();
    });

    await Promise.all(tasks);
    expect(completed).toHaveLength(4);
  });

  it("acquire resolves immediately when under max", async () => {
    const sem = new Semaphore(3);
    await sem.acquire();
    await sem.acquire();
    // Third should also resolve immediately
    await sem.acquire();
    sem.release();
    sem.release();
    sem.release();
  });
});

describe("coderPool constants", () => {
  it("LLM_CONCURRENCY is a positive integer", () => {
    expect(LLM_CONCURRENCY).toBe(2);
    expect(Number.isInteger(LLM_CONCURRENCY)).toBe(true);
  });

  it("MAX_DOMAINS is a positive integer", () => {
    expect(MAX_DOMAINS).toBe(6);
    expect(Number.isInteger(MAX_DOMAINS)).toBe(true);
  });

  it("MAX_DOMAINS is large enough for typical projects", () => {
    expect(MAX_DOMAINS).toBeGreaterThanOrEqual(2);
  });

  it("MAX_DOMAINS is small enough to prevent runaway decomposition", () => {
    expect(MAX_DOMAINS).toBeLessThanOrEqual(10);
  });
});

describe("formatMs", () => {
  it("formats sub-second durations in milliseconds", () => {
    expect(formatMs(500)).toBe("500ms");
    expect(formatMs(0)).toBe("0ms");
    expect(formatMs(999)).toBe("999ms");
  });

  it("formats multi-second durations in seconds", () => {
    expect(formatMs(1000)).toBe("1.0s");
    expect(formatMs(1500)).toBe("1.5s");
    expect(formatMs(60000)).toBe("60.0s");
  });

  it("handles exact boundaries", () => {
    expect(formatMs(999)).toBe("999ms");
    expect(formatMs(1000)).toBe("1.0s");
  });
});
