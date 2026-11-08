// A line of the TUI, as styled segments: what the view (view.ts) draws and
// the app (app.ts) renders.

export type Style =
  "plain" | "bold" | "dim" | "green" | "red" | "yellow" | "cyan" | "magenta" | "selected";

export type Segment = { readonly text: string; readonly style: Style };

export type Line = ReadonlyArray<Segment>;
