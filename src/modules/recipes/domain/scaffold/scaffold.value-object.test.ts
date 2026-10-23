import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import { ignoresToAppend, missingIgnores, scaffoldWrites } from "./scaffold.value-object.ts";

const scaffold = {
  files: { "config.yaml": "flows: {}\n", "config.schema.json": "{ new }\n" },
  generated: ["config.schema.json"],
  manifest: "{}\n",
};

describe("the scaffold", () => {
  test("writes what's missing, brings a generated file up to date, and keeps the rest", () => {
    const present = (there: Readonly<Record<string, string>>) => (file: string) =>
      Record.get(there, file);

    expect(scaffoldWrites(scaffold, present({}))).toEqual([
      { file: "config.yaml", text: "flows: {}\n", updated: false },
      { file: "config.schema.json", text: "{ new }\n", updated: false },
    ]);
    expect(
      scaffoldWrites(
        scaffold,
        present({ "config.yaml": "mine\n", "config.schema.json": "{ old }\n" }),
      ),
    ).toEqual([{ file: "config.schema.json", text: "{ new }\n", updated: true }]);
    expect(
      scaffoldWrites(scaffold, () => Option.some("mine")).filter(
        (write) => write.file === "config.yaml",
      ),
    ).toEqual([]);
  });

  test("gitignores .chernabog/node_modules/ unless node_modules is ignored already", () => {
    expect(missingIgnores("")).toEqual([".chernabog/node_modules/"]);
    expect(missingIgnores("dist\nnode_modules/\n")).toEqual([]);
    expect(ignoresToAppend("", [".chernabog/node_modules/"])).toBe(".chernabog/node_modules/\n");
    expect(ignoresToAppend("dist", [".chernabog/node_modules/"])).toBe(
      "\n.chernabog/node_modules/\n",
    );
  });
});
