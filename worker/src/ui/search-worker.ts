import { createSearchIndex, SearchError, type SearchWorkerRequest, type SearchWorkerResponse } from "../search";

// This process owns all private text. FIFO messages mutate/query one index; generation correlates
// replies, it does not drop earlier metadata/adds or act as a session token. Clear releases every record.
// The UI must terminate this process on logout/cancellation; synchronous matching cannot handle an
// interrupting message. Query/metadata budgets fail closed; body limits keep admitted names.
const scope = self as unknown as DedicatedWorkerGlobalScope;
const index = createSearchIndex();
scope.onmessage = (event: MessageEvent<SearchWorkerRequest>) => {
  const message = event.data;
  const generation = Number.isSafeInteger(message?.generation) && message.generation >= 0 ? message.generation : 0;
  try {
    if (!message || message.version !== 1 || generation !== message.generation
      || !["metadata", "add", "clear", "query"].includes(message.operation)) {
      throw new SearchError("invalid_search_request", "Expected a version 1 metadata/add/query/clear message and nonnegative safe generation.");
    }
    let response: SearchWorkerResponse = { version: 1, generation, status: "ready" };
    switch (message.operation) {
      case "metadata": index.add(message.summary); break;
      case "add":
        if (!message.text) throw new SearchError("invalid_search_request", "A body add requires a text record.");
        index.add(message.summary, message.text);
        break;
      case "clear": index.clear(); break;
      case "query": response = { ...response, status: "results", hits: index.query(message.query, message.filter) }; break;
    }
    scope.postMessage(response);
  } catch (error) {
    scope.postMessage({
      version: 1, generation, status: "error",
      code: error instanceof SearchError ? error.code : "invalid_search_request",
      message: error instanceof SearchError ? error.message : "The search request could not be processed.",
    } satisfies SearchWorkerResponse);
  }
};
