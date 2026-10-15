// The dedicated UI owner replaces this placeholder; no login, corpus, selection or deletion is active.
export {};
const status = document.querySelector("[data-library-status]");
if (status) status.textContent = "The private library is not available yet.";
