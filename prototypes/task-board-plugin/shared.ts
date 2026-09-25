// PROTOTYPE — types the author shares between server and screen. Not part of the SDK.
export type CardStatus = "todo" | "running" | "done" | "failed";

export type Card = {
  id: string;
  title: string;
  notes: string;
  status: CardStatus;
  threadId: string | null;
};
