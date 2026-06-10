package folderarchive

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
)

const mib int64 = 1024 * 1024

type Archive struct {
	Filename string
	Content  io.ReadCloser
}

type archiveFile struct {
	absolutePath string
	relativePath string
	info         os.FileInfo
}

// New prepares a streaming ZIP archive for all regular files under root.
func New(root string, maxUncompressedBytes int64) (*Archive, error) {
	files, err := collectFiles(root, maxUncompressedBytes)
	if err != nil {
		return nil, err
	}

	reader, writer := io.Pipe()
	go func() {
		writer.CloseWithError(writeZip(writer, files))
	}()

	return &Archive{
		Filename: Filename(root),
		Content:  reader,
	}, nil
}

// Filename returns the ZIP filename used for a folder upload.
func Filename(root string) string {
	base := filepath.Base(filepath.Clean(root))
	if base == "." || base == string(filepath.Separator) {
		base = "folder"
	}
	return base + ".zip"
}

func collectFiles(root string, maxUncompressedBytes int64) ([]archiveFile, error) {
	root = filepath.Clean(root)
	var files []archiveFile
	var total int64

	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}

		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)

		info, err := entry.Info()
		if err != nil {
			return fmt.Errorf("stat %s: %w", rel, err)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("cannot upload non-regular file %s", rel)
		}
		if maxUncompressedBytes >= 0 && info.Size() > maxUncompressedBytes-total {
			return fmt.Errorf("folder files total %s exceeds limit %s", formatBytes(total+info.Size()), formatBytes(maxUncompressedBytes))
		}
		total += info.Size()
		files = append(files, archiveFile{
			absolutePath: path,
			relativePath: rel,
			info:         info,
		})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("walk %s: %w", root, err)
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("no regular files found in %s", root)
	}

	sort.Slice(files, func(i, j int) bool {
		return files[i].relativePath < files[j].relativePath
	})
	return files, nil
}

func writeZip(w io.Writer, files []archiveFile) error {
	zipWriter := zip.NewWriter(w)
	for _, file := range files {
		src, err := openValidatedFile(file)
		if err != nil {
			_ = zipWriter.Close()
			return err
		}

		header, err := zip.FileInfoHeader(file.info)
		if err != nil {
			_ = src.Close()
			_ = zipWriter.Close()
			return fmt.Errorf("create zip header for %s: %w", file.relativePath, err)
		}
		header.Name = file.relativePath
		header.Method = zip.Deflate

		dst, err := zipWriter.CreateHeader(header)
		if err != nil {
			_ = src.Close()
			_ = zipWriter.Close()
			return fmt.Errorf("create zip entry for %s: %w", file.relativePath, err)
		}
		if err := copyFile(dst, src, file); err != nil {
			_ = zipWriter.Close()
			return err
		}
	}
	return zipWriter.Close()
}

func openValidatedFile(file archiveFile) (*os.File, error) {
	src, err := os.Open(file.absolutePath)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", file.relativePath, err)
	}
	info, err := src.Stat()
	if err != nil {
		_ = src.Close()
		return nil, fmt.Errorf("stat %s: %w", file.relativePath, err)
	}
	if !info.Mode().IsRegular() || !os.SameFile(file.info, info) || info.Size() != file.info.Size() {
		_ = src.Close()
		return nil, fmt.Errorf("%s changed during archive", file.relativePath)
	}
	return src, nil
}

func copyFile(dst io.Writer, src *os.File, file archiveFile) error {
	limit := &io.LimitedReader{R: src, N: file.info.Size() + 1}
	n, copyErr := io.Copy(dst, limit)
	closeErr := src.Close()
	if copyErr != nil {
		return fmt.Errorf("copy %s: %w", file.relativePath, copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close %s: %w", file.relativePath, closeErr)
	}
	if n != file.info.Size() {
		return fmt.Errorf("%s changed during archive", file.relativePath)
	}
	return nil
}

func formatBytes(size int64) string {
	if size < mib {
		return fmt.Sprintf("%d bytes", size)
	}
	if size%mib == 0 {
		return fmt.Sprintf("%d MiB", size/mib)
	}
	return fmt.Sprintf("%.1f MiB", float64(size)/float64(mib))
}
