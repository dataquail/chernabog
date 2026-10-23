import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

// Who the implicit persona is on GitHub: whoever GH_TOKEN, GITHUB_TOKEN or
// gh's active account is. None when GitHub can't say.
export type ViewerClientService = {
  readonly login: Effect.Effect<Option.Option<string>>;
};

export class ViewerClient extends Context.Service<ViewerClient, ViewerClientService>()(
  "ViewerClient",
) {}
