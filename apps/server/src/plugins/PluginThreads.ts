import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ModelSelection,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationSessionStatus,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as CommandDispatcher from "../orchestration/CommandDispatcher.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * Where a thread's turn stands, as plugins see it. `idle` means the thread has had no
 * turn yet; once one ends, the thread reports how it ended until the next one starts.
 */
export type PluginTurnState = "idle" | "running" | "completed" | "interrupted" | "error";

export interface PluginProject {
  readonly id: string;
  readonly name: string;
  readonly folder: string;
}

export interface PluginThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly turnState: PluginTurnState;
}

export interface PluginTurnStateChange {
  readonly threadId: string;
  readonly projectId: string;
  readonly state: PluginTurnState;
}

/** What a plugin passes to `threads.create`. Anything left out uses the project's defaults. */
export const PluginThreadCreateInput = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(200)),
  prompt: Schema.String.check(Schema.isPattern(/\S/)),
  model: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  /** `true` starts the thread in a new worktree, `false` in the project folder. */
  worktree: Schema.optional(Schema.Boolean),
});
export type PluginThreadCreateInput = typeof PluginThreadCreateInput.Type;

/** A readable reason a plugin's thread operation failed, surfaced to it as a rejection. */
export class PluginThreadsError extends Schema.TaggedError<PluginThreadsError>()(
  "PluginThreadsError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** The project defaults a new thread falls back to, as `resolveProjectSettings` resolves them. */
export interface ThreadDefaults {
  readonly defaultModelSelection: ModelSelection | null;
  readonly defaultRuntimeMode: RuntimeMode;
  readonly defaultThreadEnvMode: "local" | "worktree";
}

/** Fills what `input` leaves out from `defaults`; fails when neither names a model. */
export const resolveThreadOptions = (
  input: PluginThreadCreateInput,
  defaults: ThreadDefaults,
  projectName: string,
) => {
  const modelSelection = input.model ?? defaults.defaultModelSelection;
  if (modelSelection === null) {
    return Effect.fail(
      new PluginThreadsError({
        reason: `Project ${projectName} has no default model. Set a default model for this project, or pass a model to threads.create.`,
      }),
    );
  }
  return Effect.succeed({
    modelSelection,
    runtimeMode: input.runtimeMode ?? defaults.defaultRuntimeMode,
    interactionMode: input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
    worktree: input.worktree ?? defaults.defaultThreadEnvMode === "worktree",
    // Asked for explicitly, a worktree must be created; a default falls back to the folder.
    requireWorktree: input.worktree === true,
  });
};

/** A thread's turn state as its projection holds it. */
export const turnStateOf = (
  thread: Pick<OrchestrationThreadShell, "latestTurn">,
): PluginTurnState => thread.latestTurn?.state ?? "idle";

/** How a turn that was running ends when its session reaches `status`; null while it still runs. */
const settledTurnState = (
  status: OrchestrationSessionStatus,
): Exclude<PluginTurnState, "idle" | "running"> | null => {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
};

/**
 * The turn state after `event`, derived from the event itself the way the projector
 * derives the latest turn, or `undefined` when only the projection can tell. Reading
 * the projection for these events would see later ones too, so a turn that starts
 * and ends before its first event is handled would never be reported as running.
 */
export const turnStateAfterEvent = (
  previous: PluginTurnState,
  event: OrchestrationEvent,
): PluginTurnState | undefined => {
  switch (event.type) {
    case "thread.session-set": {
      const { status, activeTurnId } = event.payload.session;
      if (status === "running") return activeTurnId === null ? previous : "running";
      return previous === "running" ? (settledTurnState(status) ?? previous) : previous;
    }
    case "thread.turn-interrupt-requested":
      return previous === "running" && event.payload.turnId !== undefined
        ? "interrupted"
        : previous;
    default:
      return undefined;
  }
};

/** Events after which a thread's turn state may differ. */
const TURN_STATE_EVENTS: ReadonlySet<OrchestrationEvent["type"]> = new Set([
  "thread.session-set",
  "thread.turn-interrupt-requested",
  "thread.turn-diff-completed",
  "thread.reverted",
]);

const toProject = (project: OrchestrationProjectShell): PluginProject => ({
  id: project.id,
  name: project.title,
  folder: project.workspaceRoot,
});

const toThread = (thread: OrchestrationThreadShell): PluginThread => ({
  id: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  turnState: turnStateOf(thread),
});

const decodeCreateInput = Schema.decodeUnknownEffect(PluginThreadCreateInput);
const decodeProjectId = Schema.decodeEffect(ProjectId);
const decodeThreadId = Schema.decodeEffect(ThreadId);

/** Projects and threads as `t3.threads@0` exposes them to plugins. */
export class PluginThreads extends Context.Service<
  PluginThreads,
  {
    readonly listProjects: Effect.Effect<ReadonlyArray<PluginProject>, PluginThreadsError>;
    readonly getProject: (id: string) => Effect.Effect<PluginProject | null, PluginThreadsError>;
    /** Creates a thread and starts its first turn with `prompt`. */
    readonly createThread: (input: unknown) => Effect.Effect<PluginThread, PluginThreadsError>;
    readonly getThread: (id: string) => Effect.Effect<PluginThread | null, PluginThreadsError>;
    /**
     * Subscribes to every change of a thread's turn state from now on, in order. The
     * subscription and its per-thread memory last as long as the scope.
     */
    readonly turnStateChanges: Effect.Effect<
      Stream.Stream<PluginTurnStateChange>,
      PluginThreadsError,
      Scope.Scope
    >;
  }
>()("t3/plugins/PluginThreads") {}

const failWith = (reason: string) => (cause: unknown) =>
  Effect.logWarning("Plugin thread operation failed", { reason, cause }).pipe(
    Effect.andThen(Effect.fail(new PluginThreadsError({ reason }))),
  );

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const dispatcher = yield* CommandDispatcher.CommandDispatcher;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projectFiles = yield* T3ProjectFileLoader.T3ProjectFileLoader;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;

  const uuid = crypto.randomUUIDv4.pipe(Effect.catch(failWith("Could not generate an id")));

  const findProject = (id: string) =>
    decodeProjectId(id).pipe(
      Effect.flatMap((projectId) => snapshots.getProjectShellById(projectId)),
      Effect.map(Option.getOrNull),
      Effect.catch(failWith(`Could not read project ${id}`)),
    );

  const findThread = (id: string) =>
    decodeThreadId(id).pipe(
      Effect.flatMap((threadId) => snapshots.getThreadShellById(threadId)),
      Effect.map(Option.getOrNull),
      Effect.catch(failWith(`Could not read thread ${id}`)),
    );

  const createThread = Effect.fn("PluginThreads.createThread")(function* (raw: unknown) {
    const input = yield* decodeCreateInput(raw).pipe(
      Effect.mapError(
        (error) =>
          new PluginThreadsError({ reason: `Invalid threads.create input: ${error.message}` }),
      ),
    );
    const project = yield* findProject(input.projectId);
    if (project === null) {
      return yield* new PluginThreadsError({ reason: `Project ${input.projectId} was not found` });
    }
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.catch(failWith("Could not read settings")),
    );
    const projectFile = yield* projectFiles.load(project.workspaceRoot);
    const defaults = resolveProjectSettings(
      settings,
      project.id,
      project,
      Option.getOrNull(projectFile),
    ).settings;
    const options = yield* resolveThreadOptions(input, defaults, project.title);

    // The checked-out branch: the thread's branch, and the base of a new worktree.
    const branch = yield* gitWorkflow.localStatus({ cwd: project.workspaceRoot }).pipe(
      Effect.map((status) => (status.isRepo ? status.refName : null)),
      Effect.orElseSucceed(() => null),
    );
    if (options.requireWorktree && branch === null) {
      return yield* new PluginThreadsError({
        reason: `Project ${project.title} is not a Git repository on a branch, so it cannot start a worktree`,
      });
    }
    const worktreeBase = options.worktree ? branch : null;

    const threadId = ThreadId.make(yield* uuid);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* dispatcher
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`plugin:thread-start:${yield* uuid}`),
        threadId,
        message: {
          messageId: MessageId.make(yield* uuid),
          role: "user",
          text: input.prompt,
          attachments: [],
        },
        modelSelection: options.modelSelection,
        runtimeMode: options.runtimeMode,
        interactionMode: options.interactionMode,
        bootstrap: {
          createThread: {
            projectId: project.id,
            title: input.title.trim(),
            modelSelection: options.modelSelection,
            runtimeMode: options.runtimeMode,
            interactionMode: options.interactionMode,
            branch,
            worktreePath: null,
            createdAt,
          },
          ...(worktreeBase === null
            ? {}
            : {
                prepareWorktree: {
                  projectCwd: project.workspaceRoot,
                  baseBranch: worktreeBase,
                  branch: buildTemporaryWorktreeBranchName((bytes) =>
                    NodeCrypto.randomBytes(bytes).toString("hex"),
                  ),
                  ...(defaults.newWorktreesStartFromOrigin ? { startFromOrigin: true } : {}),
                  ...(options.requireWorktree ? { requireWorktree: true } : {}),
                },
                runSetupScript: true,
              }),
        },
        createdAt,
      })
      .pipe(Effect.mapError((error) => new PluginThreadsError({ reason: error.message })));

    const created = yield* findThread(threadId);
    return created === null
      ? ({
          id: threadId,
          projectId: project.id,
          title: input.title.trim(),
          turnState: "running",
        } satisfies PluginThread)
      : toThread(created);
  });

  const turnStateChanges = Effect.gen(function* () {
    // Subscribe before reading states, so no change between the two is lost.
    const events = yield* engine.subscribeDomainEvents;
    const snapshot = yield* snapshots
      .getShellSnapshot()
      .pipe(Effect.catch(failWith("Could not read thread states")));
    // Last known state per thread, so only real transitions reach plugins. A thread
    // missing here was created after the snapshot, and new threads start idle.
    const lastStates = new Map<string, PluginTurnState>(
      snapshot.threads.map((thread) => [thread.id, turnStateOf(thread)]),
    );
    return events.pipe(
      Stream.filter(
        (event) =>
          event.aggregateKind === "thread" &&
          (TURN_STATE_EVENTS.has(event.type) || event.type === "thread.deleted"),
      ),
      Stream.mapEffect((event) =>
        Effect.gen(function* () {
          const threadId = event.aggregateId;
          if (event.type === "thread.deleted") {
            lastStates.delete(threadId);
            return undefined;
          }
          const previous = lastStates.get(threadId) ?? "idle";
          const derived = turnStateAfterEvent(previous, event);
          if (derived === previous) return undefined;
          // Projections commit before events publish, so the shell reflects at least `event`.
          const thread = yield* snapshots.getThreadShellById(ThreadId.make(threadId)).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.orElseSucceed(() => undefined),
          );
          if (thread === undefined) return undefined;
          const state = derived ?? turnStateOf(thread);
          if (state === previous) return undefined;
          lastStates.set(threadId, state);
          return {
            threadId,
            projectId: thread.projectId,
            state,
          } satisfies PluginTurnStateChange;
        }),
      ),
      Stream.filter((change) => change !== undefined),
    );
  });

  return PluginThreads.of({
    listProjects: snapshots.getProjectShells().pipe(
      Effect.map((projects) => projects.map(toProject)),
      Effect.catch(failWith("Could not list projects")),
    ),
    getProject: (id) =>
      findProject(id).pipe(Effect.map((project) => (project === null ? null : toProject(project)))),
    createThread,
    getThread: (id) =>
      findThread(id).pipe(Effect.map((thread) => (thread === null ? null : toThread(thread)))),
    turnStateChanges,
  });
});

export const layer = Layer.effect(PluginThreads, make).pipe(
  Layer.provide(T3ProjectFileLoader.layer),
);
