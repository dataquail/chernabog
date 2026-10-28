// The package's entry where a resolver ignores package.json: Bun's compiled
// binaries resolve a bare import to a package's root index file only, and the
// chernabog binary imports each repo's installed SDK that way. Everything
// else reads `exports`, which names the same module.
export * from "./src/index.ts";
