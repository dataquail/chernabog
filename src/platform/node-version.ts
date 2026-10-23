// Each repo pins its Node in .nvmrc (functional-domain-driven-hexagon needs 24,
// the libraries 22). launchd starts with no nvm, so pick the installed version here.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

import { Home } from "./home.ts";

type Version = readonly [number, number, number];

const part = (parts: ReadonlyArray<string>, index: number) =>
  Number(Option.getOrElse(Arr.get(parts, index), () => "0"));

// "v22.14.0", "22.13", "24": a release; anything else (lts/*, a codename) is none.
const parse = (text: string): Option.Option<Version> => {
  const trimmed = text.trim();

  if (!/^v?\d+(?:\.\d+){0,2}$/.test(trimmed)) {
    return Option.none();
  }

  const parts = trimmed.replace(/^v/, "").split(".");

  return Option.some([part(parts, 0), part(parts, 1), part(parts, 2)] as const);
};

const byVersion = Order.Tuple([Order.Number, Order.Number, Order.Number]);

const compare = (a: Version, b: Version) => byVersion(a, b);

type Installed = { readonly name: string; readonly version: Version };

const newestFirst = Order.mapInput(Order.flip(byVersion), (entry: Installed) => entry.version);

// An exact match first, then the newest installed release of the same major that
// is at least the pinned one, then the newest of that major at all.
export const pickNodeVersion = (
  requested: string,
  installed: ReadonlyArray<string>,
): Option.Option<string> =>
  Option.flatMap(parse(requested), (wanted) => {
    const sameMajor = Arr.sort(
      installed.flatMap((name) =>
        Option.toArray(
          Option.map(
            Option.filter(parse(name), (version) => version[0] === wanted[0]),
            (version) => ({ name, version }),
          ),
        ),
      ),
      newestFirst,
    );

    return Arr.findFirst(sameMajor, (entry) => compare(entry.version, wanted) === 0).pipe(
      Option.orElse(() => Arr.findFirst(sameMajor, (entry) => compare(entry.version, wanted) >= 0)),
      Option.orElse(() => Arr.head(sameMajor)),
      Option.map((entry) => entry.name),
    );
  });

// The bin directory of the nvm-installed Node a checkout's .nvmrc pins, if there is one.
export const nodeBinFor = (checkout: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const versions = `${(yield* Home).user}/.nvm/versions/node`;
    const nvmrc = `${checkout}/.nvmrc`;

    if (!(yield* fs.exists(nvmrc)) || !(yield* fs.exists(versions))) {
      return Option.none<string>();
    }

    const picked = pickNodeVersion(
      yield* fs.readFileString(nvmrc),
      yield* fs.readDirectory(versions),
    );

    return Option.map(picked, (name) => `${versions}/${name}/bin`);
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));
