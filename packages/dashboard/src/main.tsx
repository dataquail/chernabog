// The dashboard's entry, which index.html loads: the page, in #root.

import * as Option from "effect/Option";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.tsx";

Option.map(Option.fromNullishOr(document.getElementById("root")), (root) => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
