// PROTOTYPE — task-board server entry, as the author would write it.
import { definePlugin, type ProjectId, type ThreadId, type TurnState } from "@t3tools/plugin-sdk/server";
import type { Card, CardStatus } from "./shared";

const key = (projectId: ProjectId) => `cards:${projectId}`;

export default definePlugin({
  async activate(t3) {
    const load = async (projectId: ProjectId) => (await t3.storage.get<Card[]>(key(projectId))) ?? [];
    const save = async (projectId: ProjectId, cards: Card[]) => {
      await t3.storage.set(key(projectId), cards);
      t3.backend.emit("cards.changed", cards, { projectId });
    };
    const requireProject = (projectId: ProjectId | null) => {
      if (projectId === null) throw new Error("Task board needs a project");
      return projectId;
    };

    t3.backend.handle<{}, Card[]>("cards.list", async (_input, ctx) => load(requireProject(ctx.projectId)));

    t3.backend.handle<{ title: string; notes?: string }, Card>("cards.add", async (input, ctx) => {
      const projectId = requireProject(ctx.projectId);
      // DECIDE (contribution-points ticket): who validates backend input — the author, or a schema in the SDK?
      const card: Card = {
        id: crypto.randomUUID(),
        title: String(input.title).trim(),
        notes: String(input.notes ?? ""),
        status: "todo",
        threadId: null,
      };
      await save(projectId, [...(await load(projectId)), card]);
      return card;
    });

    t3.backend.handle<{ id: string }, Card>("cards.start", async (input, ctx) => {
      const projectId = requireProject(ctx.projectId);
      const cards = await load(projectId);
      const card = cards.find((c) => c.id === input.id);
      if (!card) throw new Error(`No card ${input.id}`);
      // DECIDE (contribution-points ticket): what threads.create accepts beyond this, and its defaults.
      const thread = await t3.threads.create({
        projectId,
        title: card.title,
        prompt: `${card.title}\n\n${card.notes}`,
      });
      const started = { ...card, threadId: thread.id, status: "running" as const };
      await save(projectId, cards.map((c) => (c.id === card.id ? started : c)));
      return started;
    });

    // Turn progress: the server keeps card status in sync, so the screen never touches threads.
    // DECIDE: this only runs while the plugin is active. Turns that finish while it's
    // disabled are missed, so reconcile on activate with threads.get().
    t3.threads.onTurnStateChange(async (thread) => {
      const cards = await load(thread.projectId);
      const card = cards.find((c) => c.threadId === thread.id);
      if (!card) return;
      const status = statusFor(thread.turnState);
      if (status === card.status) return;
      await save(thread.projectId, cards.map((c) => (c.id === card.id ? { ...c, status } : c)));
    });

    for (const project of await t3.projects.list()) {
      const cards = await load(project.id);
      const reconciled = await Promise.all(
        cards.map(async (c) => {
          if (c.threadId === null) return c;
          const thread = await t3.threads.get(c.threadId as ThreadId);
          return thread ? { ...c, status: statusFor(thread.turnState) } : c;
        }),
      );
      await t3.storage.set(key(project.id), reconciled);
    }
  },
});

function statusFor(state: TurnState): CardStatus {
  switch (state) {
    case "running":
      return "running";
    case "completed":
      return "done";
    case "error":
    case "interrupted":
      return "failed";
    case "idle":
      return "todo";
  }
}
