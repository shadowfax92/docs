package cmd

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"
)

func TestRunListShowsLastTenUploads(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	now := time.Now().UTC()
	var entries []map[string]string
	for i := 0; i < 11; i++ {
		name := "doc-" + string(rune('A'+i)) + ".md"
		entries = append(entries, map[string]string{
			"uploaded_at": now.Add(time.Duration(i) * time.Minute).Format(time.RFC3339Nano),
			"name":        name,
			"url":         "https://example.test/" + name,
		})
	}
	writeListTestHistory(t, home, entries)

	previousListDays := listDays
	listDays = 0
	t.Cleanup(func() {
		listDays = previousListDays
	})

	var out bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&out)
	if err := runList(cmd, nil); err != nil {
		t.Fatalf("runList returned error: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, "NAME") || !strings.Contains(output, "URL") {
		t.Fatalf("output missing table headers:\n%s", output)
	}
	if strings.Contains(output, "doc-A.md") {
		t.Fatalf("output included oldest upload:\n%s", output)
	}
	if !strings.Contains(output, "doc-K.md") {
		t.Fatalf("output missing newest upload:\n%s", output)
	}
}

func TestRunListFiltersByDays(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	now := time.Now().UTC()
	writeListTestHistory(t, home, []map[string]string{
		{
			"uploaded_at": now.Add(-48 * time.Hour).Format(time.RFC3339Nano),
			"name":        "old.md",
			"url":         "https://example.test/old",
		},
		{
			"uploaded_at": now.Add(-2 * time.Hour).Format(time.RFC3339Nano),
			"name":        "recent.md",
			"url":         "https://example.test/recent",
		},
	})

	previousListDays := listDays
	listDays = 1
	t.Cleanup(func() {
		listDays = previousListDays
	})

	var out bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&out)
	if err := runList(cmd, nil); err != nil {
		t.Fatalf("runList returned error: %v", err)
	}

	output := out.String()
	if strings.Contains(output, "old.md") {
		t.Fatalf("output included upload outside --days window:\n%s", output)
	}
	if !strings.Contains(output, "recent.md") || !strings.Contains(output, "https://example.test/recent") {
		t.Fatalf("output missing recent upload:\n%s", output)
	}
}

func writeListTestHistory(t *testing.T, home string, entries []map[string]string) {
	t.Helper()
	dir := filepath.Join(home, ".config", "docs")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	data, err := json.Marshal(entries)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "uploads.json"), data, 0o600); err != nil {
		t.Fatalf("WriteFile uploads.json: %v", err)
	}
}
