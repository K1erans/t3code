// PROTOTYPE — the imagined SDK surface. Nothing implements this.
// Rules it follows (from decided tickets): every call is async, every payload is JSON.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Disposable = { dispose(): void };

declare module "@t3tools/plugin-sdk/server" {
  export type ProjectId = string & { readonly _brand: "ProjectId" };
  export type ThreadId = string & { readonly _brand: "ThreadId" };

  /** Per-plugin, per-environment key/value store. Values are JSON. */
  export interface Storage {
    get<T extends Json>(key: string): Promise<T | undefined>;
    set(key: string, value: Json): Promise<void>;
    delete(key: string): Promise<void>;
  }

  export interface Project {
    id: ProjectId;
    name: string;
    cwd: string;
  }

  /** Mirrors OrchestrationLatestTurnState, plus "idle" before the first turn. */
  export type TurnState = "idle" | "running" | "completed" | "interrupted" | "error";

  export interface ThreadSummary {
    id: ThreadId;
    projectId: ProjectId;
    title: string;
    turnState: TurnState;
  }

  export interface Threads {
    /** Creates a thread and starts its first turn. Model/runtime default to the user's settings. */
    create(input: { projectId: ProjectId; title: string; prompt: string }): Promise<ThreadSummary>;
    get(id: ThreadId): Promise<ThreadSummary | undefined>;
    /** Fires on every turn-state change of any thread in the environment. */
    onTurnStateChange(listener: (thread: ThreadSummary) => void): Disposable;
  }

  export interface Projects {
    list(): Promise<Project[]>;
  }

  /** Who is calling a backend method: which screen instance, for which project. */
  export interface CallContext {
    projectId: ProjectId | null;
  }

  export interface Backend {
    /** Methods a screen can call. Input is untrusted JSON; validate it. */
    handle<I extends Json, O extends Json>(
      method: string,
      handler: (input: I, ctx: CallContext) => Promise<O>,
    ): Disposable;
    /**
     * Push an event to this plugin's open screens. The server filters against each
     * screen subscription's context, so a scoped event never reaches other projects' screens.
     * Unscoped events go to every screen.
     */
    emit(topic: string, payload: Json, scope?: { projectId?: ProjectId }): void;
  }

  /**
   * Argument-free palette commands that return a toast. The host adds an "Open <screen title>"
   * entry for every contributed screen, following its placement, so plugins don't register those.
   */
  export interface Commands {
    register(
      id: string,
      handler: (ctx: CallContext) => Promise<{ message: string; tone?: "info" | "success" | "error" } | void>,
    ): Disposable;
  }

  export interface PluginContext {
    storage: Storage;
    projects: Projects;
    threads: Threads;
    backend: Backend;
    commands: Commands;
    log: { info(msg: string, data?: Json): void; error(msg: string, data?: Json): void };
    /** Everything registered through the context is disposed automatically; this is for your own resources. */
    onDispose(cleanup: () => void | Promise<void>): void;
  }

  export function definePlugin(plugin: { activate(t3: PluginContext): void | Promise<void> }): unknown;
}

declare module "@t3tools/plugin-sdk/screen" {
  export interface ScreenContext {
    placement: "panel" | "page" | "settings";
    /**
     * Set when the screen's manifest scope is "project". Panel: the thread/draft beside it.
     * Page: the ?project= param, with a host-owned picker defaulting to the last active thread's project.
     */
    projectId: string | null;
    theme: "light" | "dark";
  }

  export interface ScreenHost {
    context: ScreenContext;
    /** Call a method registered with backend.handle on this plugin's server. */
    call<O extends Json>(method: string, input?: Json): Promise<O>;
    /** Subscribe to backend.emit topics. Only events matching this screen's context arrive. */
    on(topic: string, listener: (payload: Json) => void): Disposable;
    onContextChange(listener: (context: ScreenContext) => void): Disposable;
    /** Host UI actions: the only way a screen affects T3's UI. Screens never read T3 data directly; ask your backend. */
    ui: {
      openThread(threadId: string): Promise<void>;
      toast(message: string, tone?: "info" | "success" | "error"): Promise<void>;
    };
  }

  /** Single-acquire, like acquireVsCodeApi. Resolves once the bridge is up. */
  export function connect(): Promise<ScreenHost>;
}
