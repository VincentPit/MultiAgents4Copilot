/**
 * Tests for src/utils/goWorkerBridge.ts — resolveGoWorkerBinary and GoWorkerBridge.
 */

import * as fs from "fs";
import * as cp from "child_process";
import { resolveGoWorkerBinary } from "../../utils/goWorkerBridge";

jest.mock("fs");
jest.mock("child_process");
jest.mock("../../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    agentMessage: jest.fn(),
    fallback: jest.fn(),
  },
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const mockCp = cp as jest.Mocked<typeof cp>;

describe("resolveGoWorkerBinary", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("returns precompiled binary path when it exists", async () => {
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      return String(p).includes("go-worker");
    });

    const result = await resolveGoWorkerBinary("/ext");
    expect(result).toContain("go-worker");
  });

  it("returns null when no precompiled binary and no go source", async () => {
    mockFs.existsSync.mockReturnValue(false);

    const result = await resolveGoWorkerBinary("/ext");
    expect(result).toBeNull();
  });

  it("returns null when go is not installed", async () => {
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      // No precompiled binary, but go.mod exists
      return String(p).includes("go.mod");
    });
    mockCp.execSync.mockImplementation(() => {
      throw new Error("go not found");
    });

    const result = await resolveGoWorkerBinary("/ext");
    expect(result).toBeNull();
  });

  it("compiles binary on demand when go is available", async () => {
    let callCount = 0;
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes("go-worker") && !s.includes("go.mod")) {
        // First check for precompiled binary returns false
        return false;
      }
      if (s.includes("go.mod")) { return true; }
      if (s.includes("out")) { return true; }
      return false;
    });
    mockCp.execSync.mockImplementation((cmd: string) => {
      if (cmd === "go version") { return Buffer.from("go version go1.22"); }
      if (String(cmd).includes("go build")) { return Buffer.from(""); }
      return Buffer.from("");
    });

    const result = await resolveGoWorkerBinary("/ext");
    expect(result).toContain("go-worker");
    // Should have called go build
    expect(mockCp.execSync).toHaveBeenCalledWith(
      expect.stringContaining("go build"),
      expect.any(Object),
    );
  });

  it("returns null when go compilation fails", async () => {
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes("go-worker") && !s.includes("go.mod")) { return false; }
      if (s.includes("go.mod")) { return true; }
      if (s.includes("out")) { return true; }
      return false;
    });
    mockCp.execSync.mockImplementation((cmd: string) => {
      if (cmd === "go version") { return Buffer.from("go version go1.22"); }
      throw new Error("build failed");
    });

    const result = await resolveGoWorkerBinary("/ext");
    expect(result).toBeNull();
  });

  it("creates output directory if it does not exist", async () => {
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes("go-worker") && !s.includes("go.mod")) { return false; }
      if (s.includes("go.mod")) { return true; }
      if (s.endsWith("out")) { return false; }
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);
    mockCp.execSync.mockImplementation((cmd: string) => {
      if (cmd === "go version") { return Buffer.from("go version go1.22"); }
      if (String(cmd).includes("go build")) { return Buffer.from(""); }
      return Buffer.from("");
    });

    await resolveGoWorkerBinary("/ext");
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("out"),
      { recursive: true },
    );
  });
});
