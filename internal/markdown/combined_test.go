package markdown

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCombineDirectoryBuildsNestedTocAndSections(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "a", "1.md"), "alpha\n")
	writeFile(t, filepath.Join(dir, "b", "2.markdown"), "# Existing title\n\nbravo\n")
	writeFile(t, filepath.Join(dir, "b", "c", "3.md"), "charlie")
	writeFile(t, filepath.Join(dir, "b", "ignored.txt"), "ignored")

	got, err := CombineDirectory(dir)
	if err != nil {
		t.Fatalf("CombineDirectory returned error: %v", err)
	}

	want := strings.Join([]string{
		"# Combined Markdown",
		"",
		"## Table of Contents",
		"",
		"- a",
		"  - [1.md](#a-1-md)",
		"- b",
		"  - [2.markdown](#b-2-markdown)",
		"  - c",
		"    - [3.md](#b-c-3-md)",
		"",
		"<a id=\"a-1-md\"></a>",
		"",
		"# 1.md",
		"",
		"alpha",
		"",
		"<a id=\"b-2-markdown\"></a>",
		"",
		"# 2.markdown",
		"",
		"# Existing title",
		"",
		"bravo",
		"",
		"<a id=\"b-c-3-md\"></a>",
		"",
		"# 3.md",
		"",
		"charlie",
		"",
	}, "\n")

	if got != want {
		t.Fatalf("combined markdown mismatch\nwant:\n%s\n\ngot:\n%s", want, got)
	}
}

func TestCombineDirectoryFailsWhenNoMarkdownFilesExist(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "notes.txt"), "not markdown")

	_, err := CombineDirectory(dir)
	if err == nil {
		t.Fatal("CombineDirectory returned nil error")
	}
	if !strings.Contains(err.Error(), "no markdown files found") {
		t.Fatalf("error = %q, want no markdown files found", err.Error())
	}
}

func TestCombineDirectoryPreservesLeadingIndentation(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "code.md"), "    fmt.Println(\"hello\")\n")

	got, err := CombineDirectory(dir)
	if err != nil {
		t.Fatalf("CombineDirectory returned error: %v", err)
	}
	if !strings.Contains(got, "\n    fmt.Println(\"hello\")\n") {
		t.Fatalf("combined markdown did not preserve leading indentation:\n%s", got)
	}
}

func TestCombinedFilenameUsesDirectoryBase(t *testing.T) {
	got := CombinedFilename(filepath.Join("docs", "guides"))
	if got != "guides.md" {
		t.Fatalf("CombinedFilename() = %q, want %q", got, "guides.md")
	}
}

func writeFile(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%q): %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}
