import * as Schema from "effect/Schema";

// What a repo's GitHub App does (#477): the author writes the code, the
// reviewer reviews it. Each is its own App, with its own login and key, so
// neither can approve the other's work as itself.
export const AppRole = Schema.Literals(["author", "reviewer"]);

export type AppRole = typeof AppRole.Type;
