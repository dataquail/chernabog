// A run log's lines. Each entry the engine writes is one line, or several
// when what it logs has newlines in it:
//
//   <ISO time>\t<step>\t<text>
//   <ISO time>\t<step>\t@<node>\t<text>
//
// `<step>` is the activity the entry was written in, the innermost when one
// runs inside another, and empty for one written outside any. `<node>` is the
// plan node the entry was written in, with its round and lane (core's
// CurrentNode), as a JSON object on one line, such as
// `@{"id":"ci","round":2,"lane":"task-10"}`; an entry written outside any
// node, as every entry of a flow with no plan is, has none. Logs from
// before steps were tagged have `<ISO time> <text>` lines, which a reader
// tells apart by the tab after the time. A person never sees the tag: every
// reader shows a tagged line as `<ISO time> <text>`, as it was before.

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// How a run's log can be split by step: by its tags; for a log from before
// tags, by its `step:` lines (`inferred`), which only holds while steps run
// one at a time, so not for a run that declared lanes (`unavailable`).
export const StepLogs = Schema.Literals(["tagged", "inferred", "unavailable"]);

export type StepLogs = typeof StepLogs.Type;

const TAGGED = /^(\d{4}-\d\d-\d\dT[^\s]*?)\t([^\t\n]*)\t(?:@(\{[^\t\n]*\})\t)?/;

const TAGGED_LINES = new RegExp(TAGGED.source, "gm");

const STEP_LINE = /^\S+ step: (.*)$/;

// A step name as a tag: one line, no tabs.
const asTag = (step: string) => step.replaceAll(/[\t\r\n]/g, " ");

// A node as a tag: `@` and the node, one line, no tabs, then the tab before the text.
const nodeTag = (node: Option.Option<string>) =>
  Option.match(node, { onNone: () => "", onSome: (found) => `@${asTag(found)}\t` });

// An entry as the log keeps it, without its trailing newline. `node` is the
// node it was written in, as a JSON object on one line; none outside any.
const entry = (
  at: string,
  step: Option.Option<string>,
  text: string,
  node: Option.Option<string> = Option.none(),
) => `${at}\t${asTag(Option.getOrElse(step, () => ""))}\t${nodeTag(node)}${text}`;

// The node a line was written in, as its tag has it: none for a line with no
// node tag, as a line of a flow with no plan, or of a log from before nodes,
// and for a line that continues the entry above it.
const nodeOf = (line: string): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(TAGGED.exec(line)), (match) =>
    Option.fromNullishOr(match[3]),
  );

// `text` as a person reads it: each tagged line without its tag.
const untagged = (text: string) => text.replaceAll(TAGGED_LINES, "$1 ");

// Whether any line of `text` carries a tag.
const carriesTags = (text: string) => new RegExp(TAGGED.source, "m").test(text);

// How a run's log splits by step: a log with no lines yet, or none at all,
// is one this binary writes, with tags.
const stepLogsOf = (text: Option.Option<string>, lanes: boolean): StepLogs => {
  const lines = Option.filter(text, (found) => found.trim().length > 0);

  if (Option.isNone(lines) || carriesTags(lines.value)) {
    return "tagged";
  }

  if (lanes) {
    return "unavailable";
  }

  return "inferred";
};

// The step a line belongs to, given the one the line before it did: its tag
// (a line with none continues the entry above it), or for an untagged log,
// the last `step:` line's.
const stepOfLine = (
  line: string,
  before: Option.Option<string>,
  logs: StepLogs,
): Option.Option<string> => {
  if (logs === "tagged") {
    return Option.match(Option.fromNullishOr(TAGGED.exec(line)), {
      onNone: () => before,
      onSome: (match) => Option.filter(Option.some(match[2]), (tag) => tag.length > 0),
    });
  }

  return Option.match(Option.fromNullishOr(STEP_LINE.exec(line)), {
    onNone: () => before,
    onSome: (match) => Option.some(match[1]),
  });
};

// What `step` wrote to a log from offset `from` on, as a person reads it, and
// the offset to read from next. Only whole lines are read, so a line being
// written is read once it is whole. `raw` is the log from its start, since
// which step a line belongs to may depend on the lines before it.
const linesOfStep = (raw: string, step: string, logs: StepLogs, from: number) => {
  const end = Math.max(from, raw.lastIndexOf("\n") + 1);
  const kept: Array<string> = [];

  if (logs !== "unavailable") {
    let offset = 0;
    let current = Option.none<string>();

    for (const line of raw.slice(0, end).split("\n").slice(0, -1)) {
      const start = offset;
      offset += line.length + 1;
      current = stepOfLine(line, current, logs);

      if (start >= from && Option.contains(current, step)) {
        kept.push(untagged(line));
      }
    }
  }

  return { text: Option.liftPredicate(kept.join("\n"), (text) => text.length > 0), next: end };
};

// The lines of a tagged log written where `keep` says, as a person reads
// them: `keep` is asked of each entry's step (empty outside any) and node
// tag (none outside any node), and a line with no tag goes with the entry
// above it.
const linesWhere = (raw: string, keep: (step: string, node: Option.Option<string>) => boolean) => {
  const kept: Array<string> = [];
  let keeping = false;

  for (const line of raw.split("\n")) {
    const tagged = Option.fromNullishOr(TAGGED.exec(line));

    if (Option.isSome(tagged)) {
      keeping = keep(tagged.value[2], Option.fromNullishOr(tagged.value[3]));
    }

    if (keeping && line.length > 0) {
      kept.push(untagged(line));
    }
  }

  return kept.join("\n");
};

export const RunLogLines = {
  entry,
  nodeOf,
  untagged,
  carriesTags,
  stepLogsOf,
  linesOfStep,
  linesWhere,
} as const;
