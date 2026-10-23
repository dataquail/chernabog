// Prints the Homebrew formula for a release, from the sha256 file the release
// workflow attaches to it. The workflow commits the output to
// dataquail/homebrew-tap as Formula/chernabog.rb.
// bun scripts/homebrew-formula.ts v0.4.0 chernabog-v0.4.0-sha256.txt

import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";

const Args = Schema.Tuple([
  Schema.String.check(Schema.isPattern(/^v\d+\.\d+\.\d+(-[\w.]+)?$/)),
  Schema.String,
]);

type Target = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";

class FormulaError extends Schema.TaggedError<FormulaError, { readonly brand: "FormulaError" }>()(
  "FormulaError",
  {
    message: Schema.String,
  },
) {}

const asset = (tag: string, target: Target) => `chernabog-${tag}-${target}.tar.gz`;

// `sha256sum` lines: "<hash>  <file>".
const checksumOf = (lines: ReadonlyArray<string>, file: string) =>
  Arr.findFirst(lines, (line) => line.endsWith(`  ${file}`)).pipe(
    Option.map((line) => line.slice(0, 64)),
    Option.filter((hash) => /^[0-9a-f]{64}$/.test(hash)),
  );

const block = (tag: string, target: Target, sha256: string) =>
  [
    `      url "https://github.com/dataquail/chernabog/releases/download/${tag}/${asset(tag, target)}"`,
    `      sha256 "${sha256}"`,
  ].join("\n");

const formula = (
  tag: string,
  sums: Readonly<Record<Target, string>>,
) => `# Written by dataquail/chernabog's release workflow (scripts/homebrew-formula.ts).
# Edits here are overwritten by the next release.
class Chernabog < Formula
  desc "Spends spare coding-agent capacity on queued work across your repos"
  homepage "https://github.com/dataquail/chernabog"
  license "MIT"

  depends_on "gh"

  on_macos do
    on_arm do
${block(tag, "darwin-arm64", sums["darwin-arm64"])}
    end
    on_intel do
${block(tag, "darwin-x64", sums["darwin-x64"])}
    end
  end

  on_linux do
    on_arm do
${block(tag, "linux-arm64", sums["linux-arm64"])}
    end
    on_intel do
${block(tag, "linux-x64", sums["linux-x64"])}
    end
  end

  def install
    bin.install "chernabog"
  end

  def caveats
    <<~EOS
      Register the daemon with launchd or systemd, then check the setup:
        chernabog install
        chernabog doctor

      After \`brew upgrade chernabog\`, restart the daemon on the new version:
        chernabog stop && chernabog start
    EOS
  end

  test do
    assert_match "chernabog v#{version}", shell_output("#{bin}/chernabog --version")
  end
end`;

const program = Effect.gen(function* () {
  const [tag, sumsPath] = yield* Schema.decodeUnknownEffect(Args)(
    yield* (yield* Stdio.Stdio).args,
  ).pipe(
    Effect.mapError(
      () =>
        new FormulaError({
          message: "usage: bun scripts/homebrew-formula.ts <vX.Y.Z tag> <sha256 file>",
        }),
    ),
  );

  const lines = (yield* (yield* FileSystem.FileSystem).readFileString(sumsPath)).split("\n");

  const sumFor = (target: Target) =>
    Effect.fromOption(checksumOf(lines, asset(tag, target))).pipe(
      Effect.mapError(
        () =>
          new FormulaError({ message: `${sumsPath} has no checksum for ${asset(tag, target)}` }),
      ),
    );

  const sums: Record<Target, string> = {
    "darwin-arm64": yield* sumFor("darwin-arm64"),
    "darwin-x64": yield* sumFor("darwin-x64"),
    "linux-arm64": yield* sumFor("linux-arm64"),
    "linux-x64": yield* sumFor("linux-x64"),
  };

  yield* Console.log(formula(tag, sums));
});

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));
