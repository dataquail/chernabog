// Which subjects each block suits, found from what it needs rather than kept
// as a list beside it that could drift. A block suits a subject when a flow on
// it can give each input the block must have:
// - an input said to come from another block (`from author.address`) is
//   there wherever that block is;
// - one said to come from the trigger (`trigger.branch`) is there where the
//   subject's trigger gives that field, of the same type;
// - one of a type (`PullRequestNumber`, `Option<BaseBranch>`) is there where
//   the subject's trigger gives one, or a block that suits it does: an
//   issue's flow has a pull request's number once pr.open gives it.
// An input of no type it names, such as a round, is there on any subject. A
// block that declares the subjects it suits suits none of the others.

import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

type Kinds = string | { readonly [field: string]: string };

export type Suitable = {
  readonly name: string;
  readonly inputs: { readonly [input: string]: "required" | "optional" };
  readonly inputKinds: { readonly [input: string]: string };
  readonly outputKinds: Kinds;
  readonly outcomeKinds: { readonly [outcome: string]: string };
  readonly suits: Option.Option<ReadonlyArray<string>>;
};

// What each subject's trigger gives, a kind for each field.
export type TriggerKinds = { readonly [subject: string]: { readonly [field: string]: string } };

// A type a kind names: a capitalised name, maybe as an Option of one, but not
// an Option of something it doesn't name, `Option<the earlier review>`.
const TYPE = /(Option<)?\b([A-Z][A-Za-z]*)\b(?!<)/g;

const LEADING_TYPE = /^(Option<)?([A-Z][A-Za-z]*)\b(?!<)/;

const BLOCK_NAME = /\b[a-z][A-Za-z]*\.[A-Za-z]+\b/g;

const TRIGGER_FIELD = /\btrigger\.(\w+)/g;

// Its groups, `Option<` when it is one and the name; join leaves out the first
// when it isn't.
const typeOf = (match: RegExpMatchArray) => match.slice(1, 3).join("");

// The type a kind starts with, which is the type of what it is.
const leadingType = (kind: string) =>
  Option.map(Option.fromNullishOr(LEADING_TYPE.exec(kind)), typeOf);

const typesIn = (kind: string) => [...kind.matchAll(TYPE)].map(typeOf);

const kindsOf = (kinds: Kinds) => {
  if (Predicate.isString(kinds)) {
    return [kinds];
  }

  return Object.values(kinds);
};

// The kinds of everything a block gives: its output and what its outcomes bind.
const givenBy = (block: Suitable) => [
  ...kindsOf(block.outputKinds),
  ...Object.values(block.outcomeKinds),
];

export const suited = (
  blocks: ReadonlyArray<Suitable>,
  triggers: TriggerKinds,
): { readonly [block: string]: ReadonlyArray<string> } => {
  const names = new Set(blocks.map((block) => block.name));
  const subjects = Object.keys(triggers);

  const suits = new Map(blocks.map((block) => [block.name, new Set<string>()]));

  const has = new Map(
    subjects.map((subject) => [
      subject,
      new Set(
        Object.values(triggers[subject] ?? {}).flatMap((kind) => Option.toArray(leadingType(kind))),
      ),
    ]),
  );

  const suitsNow = (block: string, subject: string) => suits.get(block)?.has(subject) === true;

  // Whether a flow on the subject can give an input of this kind.
  const gives = (subject: string, kind: string) => {
    const from = [...kind.matchAll(BLOCK_NAME)].flatMap((match) =>
      Option.toArray(Option.liftPredicate(match[0], (name) => names.has(name))),
    );

    if (from.length > 0) {
      return from.some((block) => suitsNow(block, subject));
    }

    const fields = [...kind.matchAll(TRIGGER_FIELD)].map((match) => match.slice(1, 2).join(""));
    const type = leadingType(kind);
    const trigger = triggers[subject] ?? {};

    if (fields.length > 0) {
      return fields.every((field) => {
        const given = Option.fromUndefinedOr(trigger[field]);

        // Of the same type, or of none on either side.
        return (
          Option.isSome(given) &&
          Option.getOrElse(leadingType(given.value), () => "") === Option.getOrElse(type, () => "")
        );
      });
    }

    return Option.match(type, {
      onNone: () => true,
      onSome: (named) => has.get(subject)?.has(named) === true,
    });
  };

  const declared = (block: Suitable, subject: string) =>
    Option.match(block.suits, {
      onNone: () => true,
      onSome: (only) => only.includes(subject),
    });

  const fits = (block: Suitable, subject: string) =>
    declared(block, subject) &&
    Object.entries(block.inputs)
      .filter(([, need]) => need === "required")
      .every(([input]) => gives(subject, block.inputKinds[input] ?? ""));

  // What a block gives, a flow it suits has, which may suit more blocks to it:
  // go round until nothing more suits.
  let more = true;

  while (more) {
    more = false;

    for (const block of blocks) {
      for (const subject of subjects) {
        if (!suitsNow(block.name, subject) && fits(block, subject)) {
          suits.get(block.name)?.add(subject);
          more = true;

          for (const type of givenBy(block).flatMap(typesIn)) {
            has.get(subject)?.add(type);
          }
        }
      }
    }
  }

  return Object.fromEntries(
    blocks.map((block) => [
      block.name,
      subjects.filter((subject) => suitsNow(block.name, subject)),
    ]),
  );
};
