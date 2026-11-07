import { Query } from "@effect-server-utils/cqrs";
import * as Arr from "effect/Array";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { Asker, type Choice } from "../../../../interface/cli/asker.prompt.ts";
import { printLines } from "../../../../interface/cli/cli.output.ts";
import { listFlag } from "../../../../interface/cli/list.arguments.ts";
import { jsonFlag } from "../../../../interface/cli/output.arguments.ts";
import { VERSION } from "../../../../platform/version.ts";
import { type RecipesAdded } from "../../commands/add-recipes.command.ts";
import { FlowDocumentsCompiled } from "../../commands/compile-flow-documents.command.ts";
import { type RecipeEjected } from "../../commands/eject-recipe.command.ts";
import { type RecipesImported } from "../../commands/import-recipes.command.ts";
import { type RecipesUpdated, type Unrecorded } from "../../commands/update-recipes.command.ts";
import { type RepoUpgraded } from "../../commands/upgrade-repo.command.ts";
import { FlowDocumentsRefused } from "../../domain/recipe/recipe.errors.ts";
import { type RecipesDiff } from "../../queries/diff-recipes.query.ts";
import { FlowCatalogue } from "../../queries/list-flow-blocks.query.ts";
import { type RecipeList } from "../../queries/list-recipes.query.ts";
import { RecipesCommands } from "../../recipes.command-handlers.ts";
import { enrollmentAccessQueries } from "../../recipes.imports.ts";
import { RecipesQueries } from "../../recipes.query-handlers.ts";
import { noPackageHint } from "./no-package-hint.util.ts";

// The checkout a path is in, the working directory's when none is given:
// which checkout is the enrollment module's to say, granted to recipes.
const rootOf = (path: Option.Option<string>) =>
  Effect.gen(function* () {
    const found = yield* Query.dispatcher(enrollmentAccessQueries).pipe(
      Effect.flatMap((enrollment) =>
        enrollment.FindCheckoutRootQuery({ path: Option.getOrElse(path, () => ".") }),
      ),
      Effect.scoped,
    );

    return found.root;
  });

// How a person names a recipe, for help text.
export const RECIPE_NAMING =
  "a bare name, such as review, from @chernabog/recipes, or <package>/<recipe> from another recipe package installed in .chernabog/";

export const recipesFlag = listFlag(
  "recipes",
  `Recipes to copy into .chernabog/, comma-separated: ${RECIPE_NAMING} (chernabog recipes list names them). Asked in a terminal; none otherwise`,
);

// The recipes to bake: the ones named, else, in a terminal, the ones a person
// picks from those the repo doesn't have yet. Piped and unnamed, none.
const chooseRecipes = (root: string, named: Option.Option<ReadonlyArray<string>>) =>
  Effect.gen(function* () {
    const asker = yield* Asker;

    if (Option.isSome(named)) {
      return named.value;
    }

    if (!asker.interactive) {
      return [];
    }

    const offered = (yield* (yield* RecipesQueries).ListRecipesQuery({ root })).recipes.filter(
      (recipe) => recipe.state === "available",
    );

    if (offered.length === 0) {
      return [];
    }

    return yield* asker.pick(
      "Which recipes should this repo copy into .chernabog/? (none is added unless you pick it)",
      offered.map((recipe): Choice => ({
        title: recipe.ref,
        value: recipe.ref,
        description: [recipe.description, ...Option.toArray(recipe.docs)].join(". "),
      })),
    );
  });

const describeAdded = (added: RecipesAdded) =>
  added.files.map(({ file, outcome, recipe, version }) =>
    Option.getOrElse(
      Option.liftPredicate(`kept ${file}, which is already there`, () => outcome === "kept"),
      () => `wrote ${file} (${recipe} recipe, ${version})`,
    ),
  );

// Copies the recipes chosen into the repo at `root`, and the lines that say
// what it wrote.
export const bakeRecipes = (root: string, named: Option.Option<ReadonlyArray<string>>) =>
  Effect.gen(function* () {
    const names = yield* chooseRecipes(root, named);

    return describeAdded(yield* (yield* RecipesCommands).AddRecipesCommand({ root, names }));
  });

const MARKS = { copied: "✓", imported: "→", available: " " } as const;

const describeList = (list: RecipeList) =>
  Option.match(Option.liftPredicate(list.packages, Arr.isReadonlyArrayNonEmpty), {
    onNone: () => [
      "No recipe packages are installed in .chernabog/. chernabog init adds @chernabog/recipes; add another with bun add -d <package> in .chernabog/.",
    ],
    onSome: (packages) =>
      packages.flatMap((found) => [
        `${found.name} ${found.version}:`,
        ...list.recipes
          .filter((recipe) => recipe.package === found.name)
          .flatMap((recipe) => [
            `${MARKS[recipe.state]} ${recipe.ref}: ${recipe.description}`,
            ...Option.toArray(Option.map(recipe.docs, (docs) => `    ${docs}`)),
          ]),
      ]),
  });

const recipesList = Command.make(
  "list",
  { path: Argument.String("path").pipe(Argument.optional) },
  ({ path }) =>
    Effect.gen(function* () {
      const root = yield* rootOf(path);

      yield* printLines(describeList(yield* (yield* RecipesQueries).ListRecipesQuery({ root })));
    }),
).pipe(
  Command.withDescription(
    "List the recipes of each recipe package installed in .chernabog/, with a check by each one the repo has copied",
  ),
);

const describeImported = (imported: RecipesImported) => [
  ...imported.flows.map(({ flow, keptFor, outcome, recipe, version }) => {
    switch (outcome) {
      case "imported": {
        return `imported ${flow} from the ${recipe} recipe, ${version} (flows.${flow}.from in .chernabog/config.yaml)`;
      }

      case "present": {
        return `${flow} already imports the ${recipe} recipe`;
      }

      case "kept": {
        return `kept ${flow}, which is ${Option.getOrElse(keptFor, () => "")} already; remove it, or name the flow you mean`;
      }
    }
  }),
  ...imported.dependencies.map(
    (name) => `.chernabog/package.json: ${name} in dependencies, which a snapshot installs`,
  ),
];

// Imports the recipes chosen into the repo at `root`, and the lines that say so.
const importRecipes = (root: string, named: Option.Option<ReadonlyArray<string>>) =>
  Effect.gen(function* () {
    const names = yield* chooseRecipes(root, named);

    if (names.length === 0) {
      return [];
    }

    return describeImported(yield* (yield* RecipesCommands).ImportRecipesCommand({ root, names }));
  });

// Brings .chernabog/'s generated schemas up to date, now that its flows may
// declare other settings, and the lines that say what it rewrote.
export const refreshSchemas = (root: string) =>
  Effect.map(
    RecipesCommands.use((commands) => commands.ScaffoldRepoCommand({ root })),
    (scaffolded) =>
      scaffolded.changes.flatMap(({ change, path }) =>
        Option.toArray(Option.liftPredicate(`wrote ${path} (updated)`, () => change === "updated")),
      ),
  );

// The lines importing, or else copying, the recipes chosen say.
const addedOrImported = (
  importing: boolean,
  root: string,
  named: Option.Option<ReadonlyArray<string>>,
) =>
  Effect.gen(function* () {
    if (importing) {
      return yield* importRecipes(root, named);
    }

    return yield* bakeRecipes(root, named);
  });

const addOrImport = (
  importing: boolean,
  root: string,
  named: Option.Option<ReadonlyArray<string>>,
) =>
  Effect.gen(function* () {
    const lines = yield* addedOrImported(importing, root, named);

    if (lines.length === 0) {
      return lines;
    }

    return [...lines, ...(yield* refreshSchemas(root))];
  });

const recipesAdd = Command.make(
  "add",
  {
    names: Argument.String("recipe").pipe(
      Argument.withDescription(
        `Recipes to copy: ${RECIPE_NAMING}. Asked in a terminal when none is named`,
      ),
      Argument.variadic(),
    ),
    importing: Flag.Boolean("import").pipe(
      Flag.withDescription(
        "Import the recipes instead of copying them: each runs from its package, which its team owns, under flows.<name>.from in config.yaml, and the package moves to dependencies",
      ),
      Flag.withDefault(false),
    ),
  },
  ({ importing, names }) =>
    Effect.gen(function* () {
      const root = yield* rootOf(Option.none());
      const named = Option.liftPredicate(names, Arr.isReadonlyArrayNonEmpty);

      const lines = yield* addOrImport(importing, root, named);

      if (lines.length === 0) {
        return yield* Console.log("Nothing added");
      }

      yield* printLines(lines);
      yield* Console.log(
        "Next: commit and merge them to the base branch, chernabog trust the repo, and chernabog enroll here to choose which personas run them.",
      );
    }),
).pipe(
  Command.withDescription(
    "Copy recipes into this repo's .chernabog/, never overwriting a file it has, and record the version each came from; or, with --import, run them from their package",
  ),
);

const describeEjected = (ejected: RecipeEjected) => [
  ...ejected.files.map(({ file, outcome }) =>
    Option.getOrElse(
      Option.liftPredicate(
        `kept ${file}, which the repo has already and which overrode the package's`,
        () => outcome === "kept",
      ),
      () => `wrote ${file} (${ejected.recipe} recipe, ${ejected.version})`,
    ),
  ),
  `removed flows.${ejected.flow}.from from .chernabog/config.yaml; ${ejected.flow} now runs from .chernabog/flows/, under the same name and settings`,
];

const recipesEject = Command.make(
  "eject",
  {
    flow: Argument.String("flow").pipe(
      Argument.withDescription("The imported flow to copy in, by its name in config.yaml"),
    ),
  },
  ({ flow }) =>
    Effect.gen(function* () {
      const root = yield* rootOf(Option.none());

      yield* printLines(
        describeEjected(yield* (yield* RecipesCommands).EjectRecipeCommand({ root, flow })),
      );
      yield* Console.log(
        "The flow is the repo's own now: edit it as you like. chernabog recipes diff shows your edits, and chernabog recipes update merges the package's later changes into them. Commit and merge it to the base branch, then chernabog trust the repo.",
      );
    }),
).pipe(
  Command.withDescription(
    "Copy an imported flow, with its prompts and steps, into this repo's .chernabog/, so the repo owns it from now on",
  ),
);

const COMPILE_OUTCOME = {
  wrote: (flow: string) => `.chernabog/flows/${flow}.ts: written`,
  unchanged: (flow: string) => `.chernabog/flows/${flow}.ts: up to date`,
  stale: (flow: string) =>
    `.chernabog/flows/${flow}.ts: not what its document compiles to; chernabog recipes compile ${flow} writes it`,
};

const describeCompiled = ({ flows, unknown }: FlowDocumentsCompiled) => [
  ...Option.toArray(
    Option.liftPredicate(
      "no flow documents in .chernabog/documents/",
      () => flows.length + unknown.length === 0,
    ),
  ),
  ...unknown.map((name) => `no document named ${name} in .chernabog/documents/`),
  ...flows.flatMap(({ flow, outcome, problems }) => {
    if (outcome === "problems") {
      return problems.map((problem) =>
        [
          `${problem.file}:${problem.line}:${problem.column}`,
          // A problem of the document as a whole has no path to say.
          ...Option.toArray(Option.liftPredicate(problem.path, (path) => path !== "")),
          problem.message,
        ].join(": "),
      );
    }

    return [COMPILE_OUTCOME[outcome](flow)];
  }),
  ...Option.toArray(
    Option.liftPredicate(
      "Types not checked: install typescript in .chernabog/ to have each wire's checked too.",
      () => flows.some((flow) => flow.outcome !== "problems" && !flow.typeChecked),
    ),
  ),
  // The check of a document's types waits on its other problems, so fixing
  // these can show more.
  ...Option.toArray(
    Option.liftPredicate(
      "Types not checked: a document's wires are checked once its other problems are fixed, so compile again after fixing these.",
      () => flows.some((flow) => flow.outcome === "problems" && !flow.typeChecked),
    ),
  ),
];

const refusal = ({ flows, unknown }: FlowDocumentsCompiled) => {
  const wrong = flows.filter((flow) => flow.outcome === "problems" || flow.outcome === "stale");

  return Option.liftPredicate(
    new FlowDocumentsRefused({
      message: `${wrong.length + unknown.length} of the flow documents named need attention`,
    }),
    () => wrong.length + unknown.length > 0,
  );
};

const CompiledText = Schema.fromJsonString(Schema.toCodecJson(FlowDocumentsCompiled));

const recipesCompile = Command.make(
  "compile",
  {
    documents: Argument.String("document").pipe(
      Argument.withDescription(
        "Documents in .chernabog/documents/ to compile, by flow; all when none is named",
      ),
      Argument.variadic(),
    ),
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Write nothing, and fail when a flow file is out of date"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  ({ check, documents, json }) =>
    Effect.gen(function* () {
      const root = yield* rootOf(Option.none());

      const compiled = yield* (yield* RecipesCommands).CompileFlowDocumentsCommand({
        root,
        names: documents,
        check,
      });

      if (json) {
        yield* Console.log(yield* Schema.encodeEffect(CompiledText)(compiled).pipe(Effect.orDie));
      } else {
        yield* printLines(describeCompiled(compiled));
      }

      for (const refused of Option.toArray(refusal(compiled))) {
        return yield* refused;
      }
    }),
).pipe(
  Command.withDescription(
    "Compile this repo's flow documents to flow files, reporting each problem at its line in the document (experimental)",
  ),
);

const listedAfter = (label: string, names: ReadonlyArray<string>) =>
  Option.toArray(Option.liftPredicate(`  ${label}: ${names.join(", ")}`, () => names.length > 0));

const describeGives = (gives: FlowCatalogue["blocks"][number]["gives"]) => {
  if (Predicate.isString(gives)) {
    return gives;
  }

  return Object.entries(gives)
    .map(([field, kind]) => `${field} (${kind})`)
    .join(", ");
};

const describeBlock = (block: FlowCatalogue["blocks"][number]) => [
  `${block.name}: ${block.about}`,
  ...block.inputs.map(
    (input) =>
      `  ${input.under} ${input.name}${Option.getOrElse(
        Option.liftPredicate(" (optional)", () => !input.required),
        () => "",
      )}: ${input.kind}`,
  ),
  `  gives: ${describeGives(block.gives)}`,
  ...block.outcomes.map(
    (outcome) =>
      `  on ${outcome.name}${Option.getOrElse(
        Option.liftPredicate(" (must route)", () => outcome.mustRoute),
        () => "",
      )}: ${outcome.binds}`,
  ),
  ...listedAfter(
    "if it fails",
    Object.entries(block.failures).map(([error, disposition]) => `${error}: ${disposition}`),
  ),
  ...listedAfter("runs before", block.before),
  ...listedAfter("needs first", block.needs),
  ...listedAfter("leaves to do", block.opens),
  ...listedAfter("does", block.closes),
  ...Option.toArray(
    Option.liftPredicate(
      "  runs last: only on a run's way out, so in a repeat it takes no round, and no way past it goes on to another round",
      () => block.last === true,
    ),
  ),
];

type CatalogueStage = NonNullable<FlowCatalogue["stages"]>[number];

const describeStage = (stage: CatalogueStage) => [
  `${stage.name}: .chernabog/stages/${stage.name}, run with stage: ${stage.name}`,
  ...stage.inputs.map(
    (input) =>
      `  ${input.under} ${input.name}${Option.getOrElse(
        Option.liftPredicate(" (optional)", () => !input.required),
        () => "",
      )}: ${input.kind}`,
  ),
  `  gives: ${describeGives(stage.gives)}`,
  ...listedAfter("say under failure what each means", stage.failures),
];

const stagesOf = (catalogue: FlowCatalogue) => catalogue.stages ?? [];

const describeSource = (source: FlowCatalogue["sources"][number]) => [
  `${source.name}: ${source.about}`,
  ...Object.entries(source.with).map(([input, kind]) => `  with ${input}: ${kind}`),
];

// A subject, with how a run on it starts: from a trigger, and by a person too
// when they can; and what a failure on it can keep, under failureContext.
const describeSubject = (subject: FlowCatalogue["subjects"][number]) =>
  [
    `  ${subject.name}: trigger gives ${subject.trigger.join(", ")}`,
    ...Option.toArray(
      Option.liftPredicate(
        "or start: true, and a person starts each run with chernabog start <issue>",
        () => subject.start === true,
      ),
    ),
    ...Option.toArray(
      Option.liftPredicate(
        `failureContext keeps ${subject.failureContext.join(", ")}`,
        () => subject.failureContext.length > 0,
      ),
    ),
  ].join("; ");

const describeCatalogue = (catalogue: FlowCatalogue) => [
  catalogue.format,
  "",
  "Subjects:",
  ...catalogue.subjects.map(describeSubject),
  "Sources:",
  ...catalogue.sources.flatMap(describeSource).map((line) => `  ${line}`),
  `Loop states: ${catalogue.loopStates.join(", ")}`,
  `Lane scopes: ${catalogue.laneScopes.join(", ")}`,
  "Blocks:",
  ...catalogue.blocks.flatMap(describeBlock),
  "Stages, this repo's own:",
  ...Option.getOrElse(
    Option.liftPredicate(stagesOf(catalogue).flatMap(describeStage), (lines) => lines.length > 0),
    () => ["  none in .chernabog/stages/"],
  ),
];

const CatalogueText = Schema.fromJsonString(Schema.toCodecJson(FlowCatalogue));

const recipesBlocks = Command.make(
  "blocks",
  {
    names: Argument.String("block").pipe(
      Argument.withDescription(
        "Blocks to describe; everything a document can use when none is named",
      ),
      Argument.variadic(),
    ),
    json: jsonFlag,
  },
  ({ json, names }) =>
    Effect.gen(function* () {
      const root = yield* rootOf(Option.none());
      const catalogue = yield* (yield* RecipesQueries).ListFlowBlocksQuery({ root });

      const known = [
        ...catalogue.blocks.map((block) => block.name),
        ...catalogue.sources.map((source) => source.name),
        ...stagesOf(catalogue).map((stage) => stage.name),
      ];

      const unknown = names.filter((name) => !known.includes(name));

      if (unknown.length > 0) {
        return yield* new FlowDocumentsRefused({
          message: `no block, source or stage named ${unknown.join(", ")}; chernabog recipes blocks lists them`,
        });
      }

      // Only the blocks and sources named, when any are.
      const named = (name: string) => names.length === 0 || names.includes(name);

      const shown = new FlowCatalogue({
        ...catalogue,
        blocks: catalogue.blocks.filter((block) => named(block.name)),
        sources: catalogue.sources.filter((source) => named(source.name)),
        stages: stagesOf(catalogue).filter((stage) => named(stage.name)),
      });

      if (json) {
        yield* Console.log(yield* Schema.encodeEffect(CatalogueText)(shown).pipe(Effect.orDie));

        return;
      }

      if (names.length === 0) {
        yield* printLines(describeCatalogue(catalogue));

        return;
      }

      yield* printLines([
        ...shown.blocks.flatMap(describeBlock),
        ...shown.sources.flatMap(describeSource),
        ...stagesOf(shown).flatMap(describeStage),
      ]);
    }),
).pipe(
  Command.withDescription(
    "List what a flow document can use, by the SDK this repo pins, with --json for an agent (experimental)",
  ),
);

const describeDiff = (diff: RecipesDiff) => {
  const lines = diff.files.flatMap(({ docs, file, recipe, recorded, state, version, ...entry }) => {
    const name = Option.getOrElse(recipe, () => "");
    const against = Option.getOrElse(version, () => "");

    const unrecorded = Option.getOrElse(
      Option.liftPredicate(
        ", the version installed, since nothing records which it came from",
        () => !recorded,
      ),
      () => "",
    );

    switch (state) {
      case "missing": {
        return [`${file}: not in the repo; chernabog recipes add ${name} copies it`];
      }

      case "same": {
        return [`${file}: the same as the ${name} recipe in ${against}${unrecorded}`];
      }

      case "differs": {
        return [
          `${file}: differs from the ${name} recipe in ${against}${unrecorded}${Option.getOrElse(
            Option.map(docs, (found) => ` (${found})`),
            () => "",
          )}`,
          ...Option.toArray(entry.diff),
        ];
      }

      case "unowned": {
        return [`${file}: from no recipe`];
      }
    }
  });

  return Option.getOrElse(Option.liftPredicate(lines, Arr.isReadonlyArrayNonEmpty), () => [
    ".chernabog/flows/ has no flows; chernabog recipes list shows the recipes",
  ]).concat(noPackageHint(diff.packagesInstalled, diff.files.length > 0));
};

// How the repo at `root` differs from the recipes it copied, for a person.
export const diffLines = (root: string, names: ReadonlyArray<string>) =>
  RecipesQueries.use((queries) => queries.DiffRecipesQuery({ root, names })).pipe(
    Effect.map(describeDiff),
  );

const recipeNames = (verb: string, none: string) =>
  Argument.String("recipe").pipe(
    Argument.withDescription(`Recipes to ${verb}; ${none} when none is named`),
    Argument.variadic(),
  );

const recipesDiff = Command.make(
  "diff",
  { names: recipeNames("compare", "every one the repo has copied") },
  ({ names }) =>
    Effect.gen(function* () {
      yield* printLines(yield* diffLines(yield* rootOf(Option.none()), names));
    }),
).pipe(
  Command.withDescription(
    "Show how this repo's copied flows differ from the version of the recipe each was copied from: the repo's own edits",
  ),
);

const UPDATED: Record<RecipesUpdated["changes"][number]["change"], string> = {
  written: "written from",
  updated: "updated to",
  merged: "merged your edits with",
  conflicted: "merged with conflicts, marked in the file; resolve them, keeping what you need of",
  adopted: "kept as it is, since nothing recorded which version it came from, and recorded as from",
  replaced:
    "replaced, since nothing recorded which version it came from; review the diff and re-apply any edits of your own, from",
};

const describeUpdate = (updated: RecipesUpdated) => [
  ...updated.packages.map(
    ({ from, name, to }) => `.chernabog/package.json: ${name} ${from} -> ${to}`,
  ),
  ...updated.changes.map(
    ({ change, file, recipe, to }) => `${file}: ${UPDATED[change]} the ${recipe} recipe in ${to}`,
  ),
];

const NOTHING_COMMITTED =
  "Nothing is committed. Review the changes (git diff .chernabog/), then commit and merge them to the base branch and chernabog trust the repo.";

const updateHere = (names: ReadonlyArray<string>, unrecorded: Unrecorded) =>
  Effect.gen(function* () {
    const root = yield* rootOf(Option.none());

    const updated = yield* (yield* RecipesCommands).UpdateRecipesCommand({
      root,
      names,
      unrecorded,
    });

    const lines = describeUpdate(updated);

    if (lines.length === 0) {
      return lines;
    }

    return [...lines, ...(yield* refreshSchemas(root))];
  });

const recipesUpdate = Command.make(
  "update",
  { names: recipeNames("update", "every one the repo has copied") },
  ({ names }) =>
    Effect.gen(function* () {
      const lines = yield* updateHere(names, "adopt");

      if (lines.length === 0) {
        return yield* Console.log("The copied recipes are up to date; nothing changed");
      }

      yield* printLines(lines);
      yield* Console.log(NOTHING_COMMITTED);
    }),
).pipe(
  Command.withDescription(
    "Bring this repo's copied recipes up to the newest version of their packages for its SDK, merging the recipes' changes into your edits, in the working tree",
  ),
);

const describeUpgrade = (upgraded: RepoUpgraded) => [
  ...Option.toArray(
    Option.liftPredicate(
      `.chernabog/package.json: lists @chernabog/sdk ${upgraded.sdkVersion} and pins this chernabog's @chernabog/core and effect`,
      () => upgraded.pinned,
    ),
  ),
  ...upgraded.left.map(({ file, missingImports }) =>
    Option.match(Option.liftPredicate(missingImports, Arr.isReadonlyArrayNonEmpty), {
      onNone: () => `${file}: from no recipe, left as it is; check it against the SDK's changes`,
      onSome: (missing) =>
        `${file}: from no recipe, left as it is; it imports what this chernabog's @chernabog/core doesn't have (${missing.join(", ")}), so move it by hand`,
    }),
  ),
  ...noPackageHint(upgraded.packagesInstalled, upgraded.left.length > 0),
];

const recipesUpgrade = Command.make("upgrade", {}, () =>
  Effect.gen(function* () {
    const root = yield* rootOf(Option.none());
    const upgraded = yield* (yield* RecipesCommands).UpgradeRepoCommand({ root });
    const lines = [...describeUpgrade(upgraded), ...(yield* updateHere([], "replace"))];

    if (lines.length === 0) {
      return yield* Console.log(`.chernabog/ is already on chernabog ${VERSION}; nothing changed`);
    }

    yield* printLines(lines);
    yield* Console.log(
      "Nothing is committed. Review the changes (git diff .chernabog/), then commit and merge them to the base branch and chernabog trust the repo.",
    );
  }),
).pipe(
  Command.withDescription(
    "Move this repo's .chernabog/ onto this chernabog's core and the SDK released with it: its pins, and its copied recipes to the newest versions for that SDK, in the working tree",
  ),
);

export const recipesEndpoint = Command.make("recipes", {}, () => Effect.void).pipe(
  Command.withDescription(
    "Complete flows from recipe packages, copied into a repo as code it then owns",
  ),
  Command.withSubcommands([
    recipesList,
    recipesAdd,
    recipesEject,
    recipesCompile,
    recipesBlocks,
    recipesDiff,
    recipesUpdate,
    recipesUpgrade,
  ]),
);
