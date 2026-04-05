/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/src/**/__tests__/**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  // Only search for source in src/ — prevents duplicate mock warning from out/
  roots: ["<rootDir>/src"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.json",
        diagnostics: { ignoreDiagnostics: [151, 151002] },
      },
    ],
  },
  moduleNameMapper: {
    // Mock the vscode module (not available outside extension host)
    "^vscode$": "<rootDir>/src/__mocks__/vscode.ts",
    // Rewrite .js extension imports to .ts for Node16 moduleResolution
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/__tests__/**",
    "!src/__mocks__/**",
  ],
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 55,
      lines: 60,
      statements: 60,
    },
  },
};
