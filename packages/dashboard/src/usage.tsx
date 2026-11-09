// What a run spent, on its page: its tokens, each category beside the total,
// what each model took, and its compute time; on a step's page, that step's
// tokens by model. "At least" when a call went unreported, and "Not recorded"
// for a run from before usage was kept, never zero.

import * as Option from "effect/Option";

import type { ModelTokens, RunUsage, TokenCounts } from "#daemon/protocol";

import { compactTokens, exactTokens, type UsageState } from "./run-usage.ts";
import { either, present, shownIf } from "./show.tsx";
import { span } from "./time.tsx";

const NOT_RECORDED = "Not recorded";

const Count = ({ count }: { readonly count: number }) => (
  <span title={exactTokens(count)}>{compactTokens(count)}</span>
);

// The total, a floor when a call went unreported; one whose calls all went
// unreported says so rather than "at least 0".
const Total = ({
  tokens,
  unreported,
}: {
  readonly tokens: TokenCounts;
  readonly unreported: boolean;
}) =>
  either(
    unreported && tokens.total === 0,
    () => <span>Not reported by its agent</span>,
    () => (
      <span className="total" title={exactTokens(tokens.total)}>
        {either(
          unreported,
          () => "At least ",
          () => "",
        )}
        {compactTokens(tokens.total)} tokens
      </span>
    ),
  );

const Categories = ({ tokens }: { readonly tokens: TokenCounts }) => (
  <span className="muted breakdown">
    {" "}
    (input <Count count={tokens.input} />, output <Count count={tokens.output} />, cache read{" "}
    <Count count={tokens.cacheRead} />, cache write <Count count={tokens.cacheWrite} />)
  </span>
);

const ByModel = ({
  label,
  models,
}: {
  readonly label: string;
  readonly models: ReadonlyArray<ModelTokens>;
}) =>
  shownIf(models.length > 0, () => (
    <div className="scroll">
      <table className="tokens" aria-label={label}>
        <thead>
          <tr>
            <th>Model</th>
            <th>Total</th>
            <th>Input</th>
            <th>Output</th>
            <th>Cache read</th>
            <th>Cache write</th>
          </tr>
        </thead>
        <tbody>
          {models.map((each) => (
            <tr key={each.model}>
              <td>{each.model}</td>
              <td>
                <Count count={each.tokens.total} />
              </td>
              <td>
                <Count count={each.tokens.input} />
              </td>
              <td>
                <Count count={each.tokens.output} />
              </td>
              <td>
                <Count count={each.tokens.cacheRead} />
              </td>
              <td>
                <Count count={each.tokens.cacheWrite} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ));

const loadedOf = (usage: UsageState) =>
  Option.liftPredicate(
    usage,
    (state): state is Extract<UsageState, { readonly kind: "loaded" }> => state.kind === "loaded",
  ).pipe(Option.map((state) => state.usage));

const RunUsageFacts = ({ usage }: { readonly usage: RunUsage }) => (
  <>
    <dl className="facts">
      <dt>Tokens</dt>
      <dd>
        {Option.match(usage.tokens, {
          onNone: () => <span className="muted">{NOT_RECORDED}</span>,
          onSome: (spent) => (
            <>
              <Total tokens={spent.tokens} unreported={spent.unreported} />
              <Categories tokens={spent.tokens} />
            </>
          ),
        })}
      </dd>
      <dt>Compute time</dt>
      <dd>
        {Option.match(usage.computeMs, {
          onNone: () => <span className="muted">{NOT_RECORDED}</span>,
          onSome: (millis) => <span>{span(millis)}</span>,
        })}
      </dd>
    </dl>
    {present(usage.tokens, (spent) => (
      <>
        <ByModel label="Tokens by model" models={spent.byModel} />
        {shownIf(spent.unreported, () => (
          <p className="muted">
            An agent call of this run didn't report what it spent, so these are floors.
          </p>
        ))}
      </>
    ))}
  </>
);

// The run's usage, once the daemon has said it; nothing while it loads, or
// from a daemon that won't say.
export const RunUsageView = ({ usage }: { readonly usage: UsageState }) =>
  present(loadedOf(usage), (loaded) => (
    <section aria-label="Usage">
      <h2>Usage</h2>
      <RunUsageFacts usage={loaded} />
    </section>
  ));

const StepUsageFacts = ({ step, usage }: { readonly step: string; readonly usage: RunUsage }) =>
  Option.match(usage.tokens, {
    onNone: () => <p className="muted">{NOT_RECORDED}</p>,
    onSome: (spent) =>
      Option.match(
        Option.fromUndefinedOr(spent.byStep.find((each) => Option.contains(each.step, step))),
        {
          onNone: () => <p className="muted">No agent call recorded in this step.</p>,
          onSome: (mine) => (
            <>
              <p>
                <Total tokens={mine.tokens} unreported={mine.unreported} />
                <Categories tokens={mine.tokens} />
              </p>
              <ByModel label={`Tokens of ${step} by model`} models={mine.byModel} />
            </>
          ),
        },
      ),
  });

// One step's tokens by model, once the daemon has said the run's.
export const StepUsageView = ({
  step,
  usage,
}: {
  readonly step: string;
  readonly usage: UsageState;
}) =>
  present(loadedOf(usage), (loaded) => (
    <section aria-label="Step usage">
      <h3>Tokens of {step}</h3>
      <StepUsageFacts step={step} usage={loaded} />
    </section>
  ));
