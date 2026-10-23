import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";

import { ViewerClient } from "../../domain/ports/clients/viewer.client.ts";

// GitHub saying the implicit persona is `login`.
export const ViewerClientFake = (login: Option.Option<string>) =>
  Layer.succeed(ViewerClient, ViewerClient.of({ login: Effect.succeed(login) }));
