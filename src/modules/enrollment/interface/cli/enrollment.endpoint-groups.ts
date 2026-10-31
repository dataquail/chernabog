// The enrollment module's CLI endpoints, which the CLI's root registers as
// its subcommands (docs/adr/0014-inbound-adapters-live-in-their-module.md).

import { enrollEndpoint } from "./enroll.endpoint.ts";
import { pauseEndpoint } from "./pause.endpoint.ts";
import { resumeEndpoint } from "./resume.endpoint.ts";
import { unenrollEndpoint } from "./unenroll.endpoint.ts";

export const enrollmentEndpoints = {
  enroll: enrollEndpoint,
  pause: pauseEndpoint,
  resume: resumeEndpoint,
  unenroll: unenrollEndpoint,
};

// What `init`, which the CLI's root composes from this module and recipes,
// takes of enrolling: its flags, the wizard, and the checkout a path is in.
export { enrollFlags, enrollHere, rootOf } from "./enroll.endpoint.ts";
