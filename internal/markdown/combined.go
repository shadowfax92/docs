package markdown

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
)

type markdownFile struct {
	absolutePath string
	relativePath string
	anchor       string
}

type tocNode struct {
	children map[string]*tocNode
	file     *markdownFile
}

// CombineDirectory recursively gathers Markdown files into one linked document.
func CombineDirectory(root string) (string, error) {
	files, err := collectMarkdownFiles(root)
	if err != nil {
		return "", err
	}
	if len(files) == 0 {
		return "", fmt.Errorf("no markdown files found in %s", root)
	}
	assignAnchors(files)

	var out bytes.Buffer
	out.WriteString("# Combined Markdown\n\n")
	writeTableOfContents(&out, files)
	for _, file := range files {
		contents, err := os.ReadFile(file.absolutePath)
		if err != nil {
			return "", fmt.Errorf("read %s: %w", file.relativePath, err)
		}
		out.WriteString("\n")
		out.WriteString(fmt.Sprintf("<a id=\"%s\"></a>\n\n", file.anchor))
		out.WriteString(fmt.Sprintf("# %s\n\n", filepath.Base(file.relativePath)))
		out.WriteString(trimBoundaryNewlines(string(contents)))
		out.WriteString("\n")
	}
	return out.String(), nil
}

// CombinedFilename returns the synthetic Markdown filename used for folder uploads.
func CombinedFilename(root string) string {
	base := filepath.Base(filepath.Clean(root))
	if base == "." || base == string(filepath.Separator) {
		base = "combined"
	}
	return base + ".md"
}

func collectMarkdownFiles(root string) ([]markdownFile, error) {
	var files []markdownFile
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !entry.Type().IsRegular() || !isMarkdownPath(path) {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		files = append(files, markdownFile{
			absolutePath: path,
			relativePath: filepath.ToSlash(rel),
		})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("walk %s: %w", root, err)
	}
	sort.Slice(files, func(i, j int) bool {
		return files[i].relativePath < files[j].relativePath
	})
	return files, nil
}

func isMarkdownPath(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return ext == ".md" || ext == ".markdown"
}

func assignAnchors(files []markdownFile) {
	seen := make(map[string]int)
	for i := range files {
		base := slug(files[i].relativePath)
		seen[base]++
		if seen[base] == 1 {
			files[i].anchor = base
			continue
		}
		files[i].anchor = fmt.Sprintf("%s-%d", base, seen[base])
	}
}

func writeTableOfContents(out *bytes.Buffer, files []markdownFile) {
	out.WriteString("## Table of Contents\n\n")
	root := &tocNode{children: make(map[string]*tocNode)}
	for i := range files {
		addToToc(root, strings.Split(files[i].relativePath, "/"), &files[i])
	}
	writeTocNode(out, root, 0)
}

func addToToc(root *tocNode, parts []string, file *markdownFile) {
	node := root
	for i, part := range parts {
		if node.children == nil {
			node.children = make(map[string]*tocNode)
		}
		child, ok := node.children[part]
		if !ok {
			child = &tocNode{children: make(map[string]*tocNode)}
			node.children[part] = child
		}
		if i == len(parts)-1 {
			child.file = file
		}
		node = child
	}
}

func writeTocNode(out *bytes.Buffer, node *tocNode, depth int) {
	names := make([]string, 0, len(node.children))
	for name := range node.children {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		child := node.children[name]
		indent := strings.Repeat("  ", depth)
		if child.file != nil {
			out.WriteString(fmt.Sprintf("%s- [%s](#%s)\n", indent, escapeMarkdownText(name), child.file.anchor))
			continue
		}
		out.WriteString(fmt.Sprintf("%s- %s\n", indent, escapeMarkdownText(name)))
		writeTocNode(out, child, depth+1)
	}
}

func slug(value string) string {
	var out strings.Builder
	previousDash := false
	for _, r := range strings.ToLower(filepath.ToSlash(value)) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			out.WriteRune(r)
			previousDash = false
			continue
		}
		if !previousDash {
			out.WriteRune('-')
			previousDash = true
		}
	}
	result := strings.Trim(out.String(), "-")
	if result == "" {
		return "section"
	}
	return result
}

func escapeMarkdownText(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `[`, `\[`, `]`, `\]`)
	return replacer.Replace(value)
}

func trimBoundaryNewlines(value string) string {
	return strings.Trim(value, "\r\n")
}
