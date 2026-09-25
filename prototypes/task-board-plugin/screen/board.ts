// PROTOTYPE — task-board screen, plain DOM so no framework is implied.
import { connect } from "@t3tools/plugin-sdk/screen";
import type { Card } from "../shared";

const t3 = await connect();
const list = document.querySelector<HTMLUListElement>("#cards")!;
const form = document.querySelector<HTMLFormElement>("#add")!;

let cards: Card[] = await t3.call<Card[]>("cards.list");
render();

// Pushed by the server whenever cards change, including turn progress.
// Server-filtered: only this screen's project arrives.
t3.on("cards.changed", (payload) => {
  cards = payload as unknown as Card[];
  render();
});

t3.onContextChange(async () => {
  cards = await t3.call<Card[]>("cards.list");
  render();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = new FormData(form).get("title");
  if (typeof title !== "string" || title.trim() === "") return;
  await t3.call("cards.add", { title });
  form.reset();
});

function render() {
  // Empty state doubles as "Start task board": the palette/nav label stays a fixed "Task board".
  form.hidden = cards.length === 0;
  if (cards.length === 0) {
    const start = document.createElement("button");
    start.textContent = "Start task board";
    start.onclick = () => {
      form.hidden = false;
      start.remove();
    };
    list.replaceChildren(start);
    return;
  }
  list.replaceChildren(
    ...cards.map((card) => {
      const item = document.createElement("li");
      item.textContent = `${card.title} — ${card.status}`;
      const button = document.createElement("button");
      if (card.threadId === null) {
        button.textContent = "Start";
        button.onclick = () => t3.call("cards.start", { id: card.id }).catch((e) => t3.ui.toast(String(e), "error"));
      } else {
        button.textContent = "Open thread";
        button.onclick = () => t3.ui.openThread(card.threadId!);
      }
      item.append(button);
      return item;
    }),
  );
}
