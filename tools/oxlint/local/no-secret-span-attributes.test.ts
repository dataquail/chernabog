// local/no-secret-span-attributes, run by the oxlint CLI over one fixture file
// per case. oxlint's RuleTester needs Node's raw transfer, which Bun lacks, so
// the cases go through the linter `bun run lint` uses, with only this rule on.

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Expected = RegExp;
type Case = { readonly code: string; readonly errors?: ReadonlyArray<{ readonly message: Expected }> };

const run = (cases: { readonly valid: ReadonlyArray<string>; readonly invalid: ReadonlyArray<Case> }) => {
  const all = [
    ...cases.valid.map((code) => ({ code, errors: [] as ReadonlyArray<{ readonly message: Expected }> })),
    ...cases.invalid.map((c) => ({ code: c.code, errors: c.errors ?? [] })),
  ];
  const dir = mkdtempSync(join(tmpdir(), "no-secret-span-attributes-"));
  const config = join(dir, "oxlintrc.json");

  writeFileSync(
    config,
    JSON.stringify({
      jsPlugins: [{ name: "local", specifier: resolve(import.meta.dir, "index.mjs") }],
      categories: { correctness: "off" },
      rules: { "local/no-secret-span-attributes": "error" },
    }),
  );
  all.forEach((c, index) => writeFileSync(join(dir, `case-${index}.ts`), c.code));

  const linted = Bun.spawnSync(
    [resolve(import.meta.dir, "../../../node_modules/.bin/oxlint"), "-c", config, "--format", "json", dir],
    { cwd: dir },
  );
  const output = JSON.parse(linted.stdout.toString()) as {
    readonly diagnostics: ReadonlyArray<{ readonly filename: string; readonly message: string }>;
  };

  rmSync(dir, { recursive: true, force: true });

  const messagesOf = (index: number) =>
    output.diagnostics
      .filter((d) => d.filename.endsWith(`case-${index}.ts`))
      .map((d) => d.message);

  describe("no-secret-span-attributes", () => {
    all.forEach((c, index) => {
      it(c.code.trim().split("\n")[0], () => {
        const messages = messagesOf(index);

        expect(messages).toHaveLength(c.errors.length);
        c.errors.forEach((error, at) => expect(messages[at]).toMatch(error.message));
      });
    });
  });
};

const key = /names a secret/;
const secretRead = /named like a secret/;
const content = /whole prompt, body or environment/;

// A command map, as the runs' maps are written.
const commandMap = (attributes: string) =>
  `const commands = { DoCommand: (message) => (${attributes}) };
   Command.dispatcher(group, { spanAttributes: commands });`;

run({
  valid: [
    // The runs' attributes, as runs.event-span-attributes.ts writes them.
    `
      const ofRun = (message) => ({ "run.id": message.runId });
      const ofFlow = (message) => ({ "run.repo": message.repo, "run.flow": message.flow });
      export const runsCommandSpanAttributes = {
        FinishRunCommand: ofRun,
        RecordSkipCommand: ofFlow,
        StartRunCommand: (payload) => ({ "run.id": payload.id, ...ofFlow(payload) }),
      } as const;
      export const runEventSpanAttributes = Event.spanAttributes({
        RunStarted: (event) => ({ "run.id": event.runId, ...ofFlow(event) }),
      });
    `,
    commandMap(`{ "session.id": message.sessionId }`),
    commandMap(`{ "session.id": message.session.id }`),
    `Effect.annotateCurrentSpan("session.id", sessionId)`,
    // Lengths and names stand in for content.
    commandMap(`{ "prompt.length": message.prompt.length }`),
    commandMap(`{ "run.author": message.author }`),
    `Effect.annotateLogs({ "run.flow": flow })`,
    `Effect.withSpan("tick", { attributes: { "run.repo": repo } })`,
    `Effect.fn("tick", { attributes: { "run.flow": flow } })`,
    // Not a place attributes are set.
    `const config = { token: env.GITHUB_TOKEN }`,
    `Effect.log("token", token)`,
  ],
  invalid: [
    // Keys, on any segment of a dotted key.
    ...[
      "token",
      "github.token",
      "secret",
      "password",
      "passwd",
      "apikey",
      "api_key",
      "api-key",
      "apiKey",
      "authorization",
      "auth",
      "auth.header",
      "cookie",
      "credential",
      "privatekey",
      "private_key",
      "session",
      "session.name",
      "GITHUB_TOKEN",
    ].map((name) => ({
      code: commandMap(`{ "${name}": message.runId }`),
      errors: [{ message: key }],
    })),
    {
      code: `Effect.annotateCurrentSpan("user.password", "x")`,
      errors: [{ message: key }],
    },
    {
      code: `Effect.annotateCurrentSpan({ token: "x" })`,
      errors: [{ message: key }],
    },
    {
      code: `Effect.withSpan("tick", { attributes: { secret: "x" } })`,
      errors: [{ message: key }],
    },
    {
      code: `effect.pipe(Effect.withSpan("tick", { attributes: { "http.cookie": "x" } }))`,
      errors: [{ message: key }],
    },
    {
      code: `Effect.fn("tick", { attributes: { credential: "x" } })`,
      errors: [{ message: key }],
    },
    {
      code: `Effect.annotateLogs("authorization", "x")`,
      errors: [{ message: key }],
    },
    {
      code: `Effect.annotateLogs({ apiKey: "x" })`,
      errors: [{ message: key }],
    },
    {
      code: `Query.dispatcher(group, { spanAttributes: { FindQuery: (q) => ({ "q.token": q.id }) } })`,
      errors: [{ message: key }],
    },
    {
      code: `makeEventBus({ spanAttributes: Event.spanAttributes({ Done: (e) => ({ cookie: e.id }) }) })`,
      errors: [{ message: key }],
    },
    {
      code: `Event.spanAttributes({ Done: (e) => { return { "run.secret": e.id }; } })`,
      errors: [{ message: key }],
    },
    // A helper the map names, in the same file.
    {
      code: `
        const ofAuth = (message) => ({ "run.auth": message.id });
        export const runsQuerySpanAttributes = { FindQuery: ofAuth };
      `,
      errors: [{ message: key }],
    },
    {
      code: `
        const ofAuth = (message) => ({ "run.auth": message.id });
        export const runsQuerySpanAttributes = { FindQuery: (q) => ({ ...ofAuth(q) }) };
      `,
      errors: [{ message: key }],
    },

    // Values that read something named like a secret.
    {
      code: commandMap(`{ "run.id": message.token }`),
      errors: [{ message: secretRead }],
    },
    {
      code: `Effect.annotateCurrentSpan("run.id", env.GITHUB_TOKEN)`,
      errors: [{ message: secretRead }],
    },
    {
      code: `Effect.annotateLogs({ "run.id": config.apiKey })`,
      errors: [{ message: secretRead }],
    },
    {
      code: `Effect.withSpan("tick", { attributes: { "run.id": String(account.privateKey) } })`,
      errors: [{ message: secretRead }],
    },
    {
      code: commandMap(`{ "run.id": \`\${message.password}\` }`),
      errors: [{ message: secretRead }],
    },
    {
      code: commandMap(`{ "run.id": env["GITHUB_TOKEN"] }`),
      errors: [{ message: secretRead }],
    },

    // Values that are a whole prompt, body or environment.
    ...["prompt", "body", "env", "process.env", "message.prompt", "request.body"].map(
      (value) => ({
        code: commandMap(`{ "run.input": ${value} }`),
        errors: [{ message: content }],
      }),
    ),
    {
      code: `Effect.annotateCurrentSpan({ "run.prompt": prompt })`,
      errors: [{ message: content }],
    },
  ],
});
