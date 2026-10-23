// Steps on an issue that any flow can use.

import { commentStep } from "./comment.ts";

// Comments on the issue, and does nothing else.
export const comment = (issue: number, body: string) => commentStep("issue", issue, body);
