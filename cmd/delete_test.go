package cmd

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/shadowfax/docs/internal/history"
)

const deleteTestID = "Ab12Cd34"

func TestDeleteCommandIsDiscoverableAndRequiresOneID(t *testing.T) {
	found, _, err := rootCmd.Find([]string{"delete"})
	if err != nil {
		t.Fatalf("Find delete command: %v", err)
	}
	if found != deleteCmd {
		t.Fatalf("found command = %q, want delete", found.Name())
	}
	if err := deleteCmd.Args(deleteCmd, nil); err == nil {
		t.Fatal("delete accepted no ID")
	}
	if err := deleteCmd.Args(deleteCmd, []string{"one", "two"}); err == nil {
		t.Fatal("delete accepted more than one ID")
	}

	var out bytes.Buffer
	rootCmd.SetOut(&out)
	t.Cleanup(func() { rootCmd.SetOut(nil) })
	if err := rootCmd.Help(); err != nil {
		t.Fatalf("root help: %v", err)
	}
	if !strings.Contains(out.String(), "delete") {
		t.Fatalf("root help does not list delete command:\n%s", out.String())
	}
	if !strings.Contains(deleteCmd.Long, "local history") || !strings.Contains(deleteCmd.Long, "cached") {
		t.Fatalf("delete help omits reconciliation or cache behavior: %q", deleteCmd.Long)
	}
}

func TestRunDeleteRemovesRemoteUploadAndOnlyMatchingHistory(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Docs-Delete-Result", "deleted")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	home := writeUploadConfigWithHome(t, server.URL, "secret")
	store := appendDeleteHistory(t, home,
		history.Entry{Name: "delete.md", ID: deleteTestID},
		history.Entry{Name: "keep.md", ID: "Other123"},
	)
	var out bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&out)

	if err := runDelete(cmd, []string{deleteTestID}); err != nil {
		t.Fatalf("runDelete returned error: %v", err)
	}
	if got := out.String(); got != "Deleted upload Ab12Cd34 and removed 1 local history entry\n" {
		t.Fatalf("output = %q, want deletion summary", got)
	}
	assertDeleteHistoryIDs(t, store, []string{"Other123"})
}

func TestRunDeleteReconcilesHistoryWhenRemoteUploadIsMissing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Docs-Delete-Result", "not-found")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("Not found"))
	}))
	defer server.Close()

	home := writeUploadConfigWithHome(t, server.URL, "secret")
	store := appendDeleteHistory(t, home,
		history.Entry{Name: "stale.md", ID: deleteTestID},
		history.Entry{Name: "keep.md", ID: "Other123"},
	)
	var out bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&out)

	if err := runDelete(cmd, []string{deleteTestID}); err != nil {
		t.Fatalf("runDelete returned error: %v", err)
	}
	if got := out.String(); got != "Upload Ab12Cd34 was not found remotely; removed 1 stale local history entry\n" {
		t.Fatalf("output = %q, want not-found reconciliation summary", got)
	}
	assertDeleteHistoryIDs(t, store, []string{"Other123"})
}

func TestRunDeleteLeavesHistoryWhenRemoteDeletionFails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("Storage error"))
	}))
	defer server.Close()

	home := writeUploadConfigWithHome(t, server.URL, "secret")
	store := appendDeleteHistory(t, home, history.Entry{Name: "keep.md", ID: deleteTestID})
	var out bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&out)

	err := runDelete(cmd, []string{deleteTestID})
	if err == nil {
		t.Fatal("runDelete returned nil error")
	}
	if !strings.Contains(err.Error(), "delete failed (HTTP 500): Storage error") {
		t.Fatalf("error = %q, want remote deletion failure", err.Error())
	}
	if out.Len() != 0 {
		t.Fatalf("output claimed success after remote failure: %q", out.String())
	}
	assertDeleteHistoryIDs(t, store, []string{deleteTestID})
}

func TestRunDeleteLeavesHistoryWhenWorkerDoesNotSupportDeletion(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("Not found"))
	}))
	defer server.Close()

	home := writeUploadConfigWithHome(t, server.URL, "secret")
	store := appendDeleteHistory(t, home, history.Entry{Name: "keep.md", ID: deleteTestID})
	cmd := &cobra.Command{}
	cmd.SetOut(&bytes.Buffer{})

	err := runDelete(cmd, []string{deleteTestID})
	if err == nil {
		t.Fatal("runDelete accepted an unmarked 404 from an older Worker")
	}
	assertDeleteHistoryIDs(t, store, []string{deleteTestID})
}

func TestRunDeleteReportsRemoteSuccessWhenHistoryCleanupFails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Docs-Delete-Result", "deleted")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	home := writeUploadConfigWithHome(t, server.URL, "secret")
	historyPath := filepath.Join(home, ".config", "docs", "uploads.json")
	if err := os.WriteFile(historyPath, []byte("not-json\n"), 0o600); err != nil {
		t.Fatalf("WriteFile malformed history: %v", err)
	}
	var out bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&out)

	err := runDelete(cmd, []string{deleteTestID})
	if err == nil {
		t.Fatal("runDelete returned nil error")
	}
	if !strings.Contains(err.Error(), "deleted remote upload Ab12Cd34, but could not update local history") {
		t.Fatalf("error = %q, want explicit partial-success context", err.Error())
	}
	if out.Len() != 0 {
		t.Fatalf("output claimed complete success after local failure: %q", out.String())
	}
}

func appendDeleteHistory(t *testing.T, home string, entries ...history.Entry) *history.Store {
	t.Helper()
	store := history.NewStore(filepath.Join(home, ".config", "docs", "uploads.json"))
	for _, entry := range entries {
		if err := store.Append(entry); err != nil {
			t.Fatalf("Append %q: %v", entry.Name, err)
		}
	}
	return store
}

func assertDeleteHistoryIDs(t *testing.T, store *history.Store, want []string) {
	t.Helper()
	entries, err := store.List(history.Filter{})
	if err != nil {
		t.Fatalf("List history: %v", err)
	}
	if len(entries) != len(want) {
		t.Fatalf("history length = %d, want %d: %+v", len(entries), len(want), entries)
	}
	for index, id := range want {
		if entries[index].ID != id {
			t.Fatalf("history[%d].ID = %q, want %q", index, entries[index].ID, id)
		}
	}
}
