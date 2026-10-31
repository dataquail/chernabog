import { Command } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ownUnitOfWork } from "../../platform/unit-of-work.ts";
import { ApplyEnrollmentCommand } from "./commands/apply-enrollment.command.ts";
import { applyEnrollmentHandler } from "./commands/apply-enrollment.handler.ts";
import { PauseRepoCommand } from "./commands/pause-repo.command.ts";
import { pauseRepoHandler } from "./commands/pause-repo.handler.ts";
import { RepointRepoCommand } from "./commands/repoint-repo.command.ts";
import { repointRepoHandler } from "./commands/repoint-repo.handler.ts";
import { ResumeRepoCommand } from "./commands/resume-repo.command.ts";
import { resumeRepoHandler } from "./commands/resume-repo.handler.ts";
import { SetFlowScheduleCommand } from "./commands/set-flow-schedule.command.ts";
import { setFlowScheduleHandler } from "./commands/set-flow-schedule.handler.ts";
import { SetPersonaAccountCommand } from "./commands/set-persona-account.command.ts";
import { setPersonaAccountHandler } from "./commands/set-persona-account.handler.ts";
import { SetPersonaFlowCommand } from "./commands/set-persona-flow.command.ts";
import { setPersonaFlowHandler } from "./commands/set-persona-flow.handler.ts";
import { UnenrollRepoCommand } from "./commands/unenroll-repo.command.ts";
import { unenrollRepoHandler } from "./commands/unenroll-repo.handler.ts";

export const enrollmentCommandGroup = Command.group(
  ApplyEnrollmentCommand,
  PauseRepoCommand,
  RepointRepoCommand,
  ResumeRepoCommand,
  SetFlowScheduleCommand,
  SetPersonaAccountCommand,
  SetPersonaFlowCommand,
  UnenrollRepoCommand,
);

const EnrollmentCommandHandlersLive = Command.handlersOf(enrollmentCommandGroup, {
  ApplyEnrollmentCommand: (payload) => applyEnrollmentHandler(payload),
  PauseRepoCommand: (payload) => pauseRepoHandler(payload),
  RepointRepoCommand: (payload) => repointRepoHandler(payload),
  ResumeRepoCommand: (payload) => resumeRepoHandler(payload),
  SetFlowScheduleCommand: (payload) => setFlowScheduleHandler(payload),
  SetPersonaAccountCommand: (payload) => setPersonaAccountHandler(payload),
  SetPersonaFlowCommand: (payload) => setPersonaFlowHandler(payload),
  UnenrollRepoCommand: (payload) => unenrollRepoHandler(payload),
});

// The enrollment module's slice of the write side, which enroll, init, pause,
// resume, unenroll, rehearse and the TUI dispatch. Its commands say what
// happened to a repo (RepoEnrolled, RepoPaused, RepoResumed, RepoUnenrolled)
// on the EventBus the composition root provides.
export class EnrollmentCommands extends Context.Service<
  EnrollmentCommands,
  Command.Dispatcher<typeof enrollmentCommandGroup>
>()("EnrollmentCommands") {}

export const EnrollmentCommandsLive = Layer.effect(
  EnrollmentCommands,
  Effect.flatMap(ownUnitOfWork, (own) =>
    Command.dispatcher(enrollmentCommandGroup, { middleware: [own] }),
  ),
).pipe(Layer.provideMerge(EnrollmentCommandHandlersLive));
