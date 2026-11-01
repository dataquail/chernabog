// The page: the daemon's status once /api/status answers, or why it didn't.

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { useEffect, useState } from "react";

import { type DaemonStatus } from "#daemon/protocol";

import { DaemonStatusView } from "./daemon-status.tsx";
import { loadStatus } from "./status.ts";

type Page = Data.TaggedEnum<{
  Asking: Record<never, never>;
  Answered: { readonly status: DaemonStatus };
  Unanswered: { readonly message: string };
}>;

const Page = Data.taggedEnum<Page>();

export const App = () => {
  const [page, setPage] = useState<Page>(Page.Asking());

  useEffect(() => {
    const asking = Effect.runFork(
      loadStatus(location.origin).pipe(
        Effect.match({
          onFailure: (error) => Page.Unanswered({ message: error.message }),
          onSuccess: (status) => Page.Answered({ status }),
        }),
        Effect.flatMap((answer) =>
          Effect.sync(() => {
            setPage(answer);
          }),
        ),
        Effect.provide(FetchHttpClient.layer),
      ),
    );

    return () => {
      Effect.runFork(Fiber.interrupt(asking));
    };
  }, []);

  return (
    <main>
      <h1>Chernabog</h1>
      {Page.$match(page, {
        Asking: () => <p>Asking the daemon…</p>,
        Answered: ({ status }) => <DaemonStatusView status={status} />,
        Unanswered: ({ message }) => <p role="alert">{message}</p>,
      })}
    </main>
  );
};
