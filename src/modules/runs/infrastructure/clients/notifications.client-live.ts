// A persona's GitHub notifications, polled as GitHub asks pollers to: with
// If-Modified-Since, so an answer that nothing changed is a 304 that costs no
// rate limit, and no sooner than its X-Poll-Interval. Reading them never marks
// them read.

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

import { type Persona } from "../../../../kernel/persona.value-object.ts";
import { decodeBody, GitHubApi } from "../../../../platform/github-api.ts";
import {
  type Notification,
  NotificationsClient,
  type NotificationsPage,
} from "../../domain/ports/clients/notifications.client.ts";
import { NotificationsUnavailable } from "../../domain/schedule/event-tick.errors.ts";

const NotificationFile = Schema.Struct({
  reason: Schema.String,
  updated_at: Schema.String,
  repository: Schema.Struct({ full_name: Schema.String }),
  subject: Schema.Struct({ url: Schema.OptionFromNullOr(Schema.String) }),
});

const NotificationsFile = Schema.Array(NotificationFile);

// GitHub's own default, when an answer doesn't say.
const DEFAULT_POLL_INTERVAL = Duration.seconds(60);

// The most notifications one poll reads. One it leaves out costs only latency:
// cron ticks the flow regardless.
const PAGE_SIZE = 50;

// The issue or pull request a notification's subject is, by its API url.
const itemOf = (url: Option.Option<string>) =>
  Option.flatMap(url, (found) =>
    Option.map(Option.fromNullishOr(/\/(?:issues|pulls)\/(\d+)$/.exec(found)), (match) =>
      Number(match[1]),
    ),
  );

const toNotification = (file: typeof NotificationFile.Type): Notification => ({
  repo: file.repository.full_name,
  item: itemOf(file.subject.url),
  reason: file.reason,
  updatedAt: file.updated_at,
});

const pollIntervalOf = (headers: Readonly<Record<string, string>>) =>
  Option.getOrElse(
    Option.flatMap(Record.get(headers, "x-poll-interval"), (seconds) =>
      Option.liftPredicate(Number(seconds), (count) => Number.isFinite(count) && count > 0),
    ).pipe(Option.map(Duration.seconds)),
    () => DEFAULT_POLL_INTERVAL,
  );

const who = (persona: Persona) =>
  Option.getOrElse(
    Option.map(persona, (login) => `${login}'s`),
    () => "this machine's",
  );

// What GitHub's refusal means for a persona, and what fixes it.
const refused = (persona: Persona, status: number) => {
  const login = Option.getOrElse(persona, () => "<login>");

  if (status === 401) {
    return new NotificationsUnavailable({
      reason: `GitHub refused ${who(persona)} token`,
      fix: `log in again with gh auth login, then gh auth switch --user ${login}`,
    });
  }

  if (status === 403 || status === 404) {
    return new NotificationsUnavailable({
      reason: `${who(persona)} token can't read notifications (fine-grained tokens can't)`,
      fix: `use gh's own login with the repo or notifications scope: gh auth switch --user ${login} && gh auth refresh --scopes notifications`,
    });
  }

  return new NotificationsUnavailable({
    reason: `GitHub answered ${who(persona)} notifications with HTTP ${status}`,
    fix: "it is tried again on the next poll",
  });
};

const pollAs = (
  persona: Persona,
  lastModified: Option.Option<string>,
  since: string,
): Effect.Effect<NotificationsPage, NotificationsUnavailable, GitHubApi> =>
  Effect.gen(function* () {
    const api = yield* GitHubApi;

    const query = new URLSearchParams({
      all: "true",
      since,
      per_page: String(PAGE_SIZE),
    });

    const response = yield* api.request(
      "GET",
      `/notifications?${query.toString()}`,
      Option.none(),
      Option.match(lastModified, {
        onNone: () => ({}),
        onSome: (modified) => ({ "If-Modified-Since": modified }),
      }),
    );

    const pollInterval = pollIntervalOf(response.headers);

    if (response.status === 304) {
      return { changed: false, lastModified, pollInterval, notifications: [] };
    }

    if (response.status >= 300) {
      return yield* refused(persona, response.status);
    }

    const files = yield* decodeBody(NotificationsFile, "GET /notifications")(response.body);

    return {
      changed: true,
      lastModified: Option.orElse(
        Record.get(response.headers, "last-modified"),
        () => lastModified,
      ),
      pollInterval,
      notifications: files.map(toNotification),
    };
  }).pipe(
    Effect.catchTag("GitHubError", (error) =>
      Effect.fail(
        new NotificationsUnavailable({
          reason: `could not read ${who(persona)} notifications: ${error.message}`,
          fix: "it is tried again on the next poll",
        }),
      ),
    ),
  );

// The client over each persona's GitHub API, as `apiFor` builds it.
export const NotificationsClientLive = <R>(
  apiFor: (persona: Persona) => Layer.Layer<GitHubApi, never, R>,
) =>
  Layer.effect(
    NotificationsClient,
    Effect.gen(function* () {
      const context = yield* Effect.context<R>();

      return NotificationsClient.of({
        poll: (persona, lastModified, since) =>
          pollAs(persona, lastModified, since).pipe(
            Effect.provide(apiFor(persona)),
            Effect.provideContext(context),
          ),
      });
    }),
  );
