import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as CommandDispatcher from "../orchestration/CommandDispatcher.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PluginThreads from "./PluginThreads.ts";

const projectId = ProjectId.make("project-1");
const project: OrchestrationProjectShell = {
  id: projectId,
  title: "Acme",
  workspaceRoot: "/work/acme",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };
const claude = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };

interface Fixture {
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly isRepo?: boolean;
  /** Domain events after the shell snapshot, numbered from 1; the event store returns them all. */
  readonly events?: ReadonlyArray<OrchestrationEvent>;
  /** How many of `events` were published before the plugin subscribed, so only replay has them. */
  readonly publishedBeforeSubscribe?: number;
  /** Dispatch creates the thread, then never finishes, like a long worktree setup. */
  readonly slowBootstrap?: boolean;
  /** Threads in the shell snapshot taken when the plugin subscribes. */
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
  /** Thread shells as the projection holds them while the events are handled. */
  readonly projectedThreads?: Record<string, OrchestrationThreadShell>;
}

/** `PluginThreads` over stub services, recording every command it dispatches. */
const makeThreads = ({
  settings = {},
  isRepo = true,
  events = [],
  publishedBeforeSubscribe = 0,
  slowBootstrap = false,
  threads = [],
  projectedThreads = {},
}: Fixture = {}) => {
  const dispatched: Array<OrchestrationCommand> = [];
  const stored = events.map((event, index) => ({ ...event, sequence: index + 1 }));
  let announceCreated!: (event: OrchestrationEvent) => void;
  const threadCreated = new Promise<OrchestrationEvent>((resolve) => {
    announceCreated = resolve;
  });
  const layer = Layer.effect(PluginThreads.PluginThreads, PluginThreads.make).pipe(
    Layer.provide(
      Layer.mock(CommandDispatcher.CommandDispatcher)({
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }).pipe(
            Effect.tap(() =>
              slowBootstrap && command.type === "thread.turn.start"
                ? Effect.sync(() =>
                    announceCreated(threadEvent("thread.created", command.threadId, {})),
                  ).pipe(Effect.andThen(Effect.never))
                : Effect.void,
            ),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getProjectShells: () => Effect.succeed([project]),
        getProjectShellById: (id) =>
          Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
        getThreadShellById: (id) => Effect.succeed(Option.fromNullishOr(projectedThreads[id])),
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 0,
            projects: [project],
            threads,
            updatedAt: project.updatedAt,
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
        subscribeDomainEvents: Effect.succeed(
          slowBootstrap
            ? Stream.fromEffect(Effect.promise(() => threadCreated))
            : Stream.fromIterable(stored.slice(publishedBeforeSubscribe)),
        ),
        readEvents: (fromSequenceExclusive) =>
          Stream.fromIterable(stored.filter((event) => event.sequence > fromSequenceExclusive)),
      }),
    ),
    Layer.provide(
      Layer.mock(T3ProjectFileLoader.T3ProjectFileLoader)({
        load: () => Effect.succeedNone,
      }),
    ),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        localStatus: () =>
          Effect.succeed({
            isRepo,
            hasPrimaryRemote: false,
            isDefaultRef: true,
            refName: isRepo ? "main" : null,
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          } as VcsStatusLocalResult),
      }),
    ),
    Layer.provide(ServerSettings.layerTest(settings)),
  );
  const create = (input: typeof PluginThreads.PluginThreadCreateInput.Encoded) =>
    PluginThreads.PluginThreads.pipe(
      Effect.flatMap((threads) => threads.createThread(input)),
      Effect.provide(layer),
    );
  const turnStart = () => {
    const command = dispatched.at(-1);
    if (command?.type !== "thread.turn.start") throw new Error("no thread.turn.start dispatched");
    return command;
  };
  const changes = PluginThreads.PluginThreads.pipe(
    Effect.flatMap((service) => service.turnStateChanges),
    Effect.flatMap(Stream.runCollect),
    Effect.scoped,
    Effect.provide(layer),
  );
  return { create, changes, dispatched, turnStart };
};

const input = { projectId, title: "Fix the build", prompt: "The build is red, fix it." };

it.layer(NodeServices.layer)("plugin threads", (it) => {
  it.effect("starts a thread with the project's effective defaults", () =>
    Effect.gen(function* () {
      const fixture = makeThreads({
        settings: {
          defaultModelSelection: codex,
          projectSettingsOverrides: {
            [projectId]: { defaultModelSelection: claude, defaultRuntimeMode: "approval-required" },
          },
        },
      });
      const thread = yield* fixture.create(input);

      expect(thread).toMatchObject({ projectId, title: "Fix the build", turnState: "running" });
      const command = fixture.turnStart();
      expect(command).toMatchObject({
        threadId: thread.id,
        message: { role: "user", text: input.prompt, attachments: [] },
        modelSelection: claude,
        runtimeMode: "approval-required",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId,
            title: "Fix the build",
            modelSelection: claude,
            branch: "main",
            worktreePath: null,
          },
        },
      });
      // The project defaults to the local checkout, and the plugin's title is kept.
      expect(command.bootstrap?.prepareWorktree).toBeUndefined();
      expect(command.titleSeed).toBeUndefined();
    }),
  );

  it.effect("returns once the thread exists, without waiting for its setup", () =>
    Effect.gen(function* () {
      const fixture = makeThreads({
        settings: { defaultModelSelection: codex },
        slowBootstrap: true,
      });
      const thread = yield* fixture.create(input);
      expect(thread).toMatchObject({ projectId, title: "Fix the build" });
      expect(fixture.turnStart().threadId).toBe(thread.id);
    }),
  );

  it.effect("lets the plugin override every default", () =>
    Effect.gen(function* () {
      const fixture = makeThreads({
        settings: { defaultModelSelection: codex, newWorktreesStartFromOrigin: true },
      });
      yield* fixture.create({
        ...input,
        model: claude,
        runtimeMode: "approval-required",
        interactionMode: "plan",
        worktree: true,
      });

      const command = fixture.turnStart();
      expect(command).toMatchObject({
        modelSelection: claude,
        runtimeMode: "approval-required",
        interactionMode: "plan",
        bootstrap: {
          prepareWorktree: {
            projectCwd: "/work/acme",
            baseBranch: "main",
            startFromOrigin: true,
            requireWorktree: true,
          },
          runSetupScript: true,
        },
      });
      expect(command.bootstrap?.prepareWorktree?.branch).toMatch(/^t3code\/[0-9a-f]{8}$/);
    }),
  );

  it.effect("starts in a worktree when the project defaults to one", () =>
    Effect.gen(function* () {
      const fixture = makeThreads({
        settings: { defaultModelSelection: codex, defaultThreadEnvMode: "worktree" },
      });
      yield* fixture.create(input);
      const worktree = fixture.turnStart().bootstrap?.prepareWorktree;
      expect(worktree).toMatchObject({ baseBranch: "main" });
      // A default falls back to the checkout where a worktree is impossible.
      expect(worktree?.requireWorktree).toBeUndefined();
    }),
  );

  it.effect("uses the checkout when a worktree default meets a folder without Git", () =>
    Effect.gen(function* () {
      const fixture = makeThreads({
        settings: { defaultModelSelection: codex, defaultThreadEnvMode: "worktree" },
        isRepo: false,
      });
      yield* fixture.create(input);
      expect(fixture.turnStart().bootstrap).toMatchObject({ createThread: { branch: null } });
      expect(fixture.turnStart().bootstrap?.prepareWorktree).toBeUndefined();

      const error = yield* Effect.flip(fixture.create({ ...input, worktree: true }));
      expect(error.message).toContain("cannot start a worktree");
    }),
  );

  it.effect("asks for a project default model when none is given or set", () =>
    Effect.gen(function* () {
      const fixture = makeThreads();
      const error = yield* Effect.flip(fixture.create(input));
      expect(error.message).toContain("Set a default model for this project");
      expect(fixture.dispatched).toEqual([]);
    }),
  );

  it.effect("rejects malformed input and unknown projects before dispatching", () =>
    Effect.gen(function* () {
      const fixture = makeThreads({ settings: { defaultModelSelection: codex } });
      const blank = yield* Effect.flip(fixture.create({ ...input, prompt: "  " }));
      expect(blank.message).toContain("Invalid threads.create input");
      const missing = yield* Effect.flip(
        fixture.create({ ...input, projectId: ProjectId.make("gone") }),
      );
      expect(missing.message).toBe("Project gone was not found");
      expect(fixture.dispatched).toEqual([]);
    }),
  );
});

const session = (status: NonNullable<OrchestrationThreadShell["session"]>["status"]) =>
  ({ status }) as NonNullable<OrchestrationThreadShell["session"]>;
const turn = (state: NonNullable<OrchestrationThreadShell["latestTurn"]>["state"]) =>
  ({ state }) as NonNullable<OrchestrationThreadShell["latestTurn"]>;
const shell = (
  id: string,
  status: NonNullable<OrchestrationThreadShell["session"]>["status"] | null,
  turnState: NonNullable<OrchestrationThreadShell["latestTurn"]>["state"] | null,
) =>
  ({
    id: ThreadId.make(id),
    projectId,
    session: status === null ? null : session(status),
    latestTurn: turnState === null ? null : turn(turnState),
  }) as OrchestrationThreadShell;
const threadEvent = (type: OrchestrationEvent["type"], threadId: string, payload?: object) =>
  ({ type, aggregateKind: "thread", aggregateId: threadId, payload }) as OrchestrationEvent;
const sessionSet = (
  threadId: string,
  status: NonNullable<OrchestrationThreadShell["session"]>["status"],
  activeTurnId: string | null = status === "running" ? "turn-1" : null,
) => threadEvent("thread.session-set", threadId, { threadId, session: { status, activeTurnId } });

it("reads a thread's turn state from its latest turn", () => {
  expect(PluginThreads.turnStateOf({ latestTurn: null })).toBe("idle");
  expect(PluginThreads.turnStateOf({ latestTurn: turn("running") })).toBe("running");
  expect(PluginThreads.turnStateOf({ latestTurn: turn("interrupted") })).toBe("interrupted");
});

it.layer(NodeServices.layer)("plugin turn state changes", (it) => {
  it.effect("reports every transition, even of a turn that ended before it was handled", () =>
    Effect.gen(function* () {
      const fixture = makeThreads({
        // "done" finished a turn before the plugin subscribed.
        threads: [shell("done", "ready", "completed")],
        events: [
          // A session update that leaves the finished turn as it was.
          sessionSet("done", "ready"),
          // A thread created after the snapshot starts idle. Its turn has already ended by
          // the time these events are handled, yet it still reports as running first.
          sessionSet("fast", "starting"),
          sessionSet("fast", "running"),
          sessionSet("fast", "running"),
          sessionSet("fast", "ready"),
          // An interrupted turn stays interrupted when its session settles.
          sessionSet("stopped", "running"),
          threadEvent("thread.turn-interrupt-requested", "stopped", { turnId: "turn-1" }),
          sessionSet("stopped", "ready"),
          // Only the projection can tell how a checkpoint left the turn.
          threadEvent("thread.turn-diff-completed", "broken"),
          // Messages never change the turn state.
          threadEvent("thread.message-sent", "fast"),
          threadEvent("thread.deleted", "done"),
        ],
        projectedThreads: {
          done: shell("done", "ready", "completed"),
          fast: shell("fast", "ready", "completed"),
          stopped: shell("stopped", "ready", "interrupted"),
          broken: shell("broken", "ready", "error"),
        },
      });
      expect(yield* fixture.changes).toEqual([
        { threadId: "fast", projectId, state: "running" },
        { threadId: "fast", projectId, state: "completed" },
        { threadId: "stopped", projectId, state: "running" },
        { threadId: "stopped", projectId, state: "interrupted" },
        { threadId: "broken", projectId, state: "error" },
      ]);
    }),
  );

  it.effect("reports changes made between the snapshot and the subscription once", () =>
    Effect.gen(function* () {
      const fixture = makeThreads({
        threads: [shell("early", "ready", "completed")],
        // The turn starts before the subscription is ready and ends after it, so the
        // store and the live stream both hold the ending.
        events: [sessionSet("early", "running"), sessionSet("early", "ready")],
        publishedBeforeSubscribe: 1,
        projectedThreads: { early: shell("early", "ready", "completed") },
      });
      expect(yield* fixture.changes).toEqual([
        { threadId: "early", projectId, state: "running" },
        { threadId: "early", projectId, state: "completed" },
      ]);
    }),
  );
});
