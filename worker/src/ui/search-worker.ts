import { createSearchIndex, type SearchWorkerRequest, type SearchWorkerResponse } from "../search";

// This process owns the index lifecycle; messages contain inert metadata/text, never credentials.
const scope = self as unknown as DedicatedWorkerGlobalScope;
const index = createSearchIndex();
scope.onmessage = (event: MessageEvent<SearchWorkerRequest>) => {
  const message = event.data;
  try {
    let response: SearchWorkerResponse = { version: 1, generation: message.generation, status: "ready" };
    switch (message.operation) {
      case "add": index.add(message.summary, message.text); break;
      case "clear": index.clear(); break;
      case "query": response = { ...response, status: "results", hits: index.query(message.query, message.filter) }; break;
    }
    scope.postMessage(response);
  } catch {
    scope.postMessage({
      version: 1, generation: message.generation, status: "error",
      code: "search_unavailable", message: "Content search is unavailable in this skeleton.",
    } satisfies SearchWorkerResponse);
  }
};
