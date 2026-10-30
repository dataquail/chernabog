import { Command } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { ApplyEnrollmentCommand } from "./commands/apply-enrollment.command.ts";
import { applyEnrollmentHandler } from "./commands/apply-enrollment.handler.ts";
import { PauseRepoCommand } from "./commands/pause-repo.command.ts";
import { pauseRepoHandler } from "./commands/pause-repo.handler.ts";
import { RepointRepoCommand } from "./commands/repoint-repo.command.ts";
import { repointRepoHandler } from "./commands/repoint-repo.handler.ts";
import { ResumeRepoCommand } from "./commands/resume-repo.command.ts";
import { resumeRepoHandler } from "./commands/resume-repo.handler.ts";
import { EnrollmentLayer } from "./enrollment.layer.ts";

export const enrollmentCommandGroup = Command.group(
  ApplyEnrollmentCommand,
  PauseRepoCommand,
  RepointRepoCommand,
  ResumeRepoCommand,
);

const EnrollmentCommandHandlersLive = Command.handlersOf(enrollmentCommandGroup, {
  ApplyEnrollmentCommand: (payload) => applyEnrollmentHandler(payload),
  PauseRepoCommand: (payload) => pauseRepoHandler(payload),
  RepointRepoCommand: (payload) => repointRepoHandler(payload),
  ResumeRepoCommand: (payload) => resumeRepoHandler(payload),
}).pipe(Layer.provide(EnrollmentLayer));

// The enrollment module's slice of the write side, which enroll, init, pause,
// resume, rehearse and the TUI dispatch.
export class EnrollmentCommands extends Context.Service<
  EnrollmentCommands,
  Command.Dispatcher<typeof enrollmentCommandGroup>
>()("EnrollmentCommands") {}

export const EnrollmentCommandsLive = Layer.effect(
  EnrollmentCommands,
  Command.dispatcher(enrollmentCommandGroup),
).pipe(Layer.provideMerge(EnrollmentCommandHandlersLive));
