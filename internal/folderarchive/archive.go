package folderarchive

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
)

type archiveFile struct {
	path string
	rel  string
	info os.FileInfo
}

// WriteZip writes regular files under root to a zip after enforcing an aggregate size limit.
func WriteZip(root string, destination string, maxBytes int64) error {
	files, err := collectFiles(root, maxBytes)
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return fmt.Errorf("no regular files found in %s", root)
	}

	out, err := os.Create(destination)
	if err != nil {
		return fmt.Errorf("create archive: %w", err)
	}
	success := false
	defer func() {
		if !success {
			_ = os.Remove(destination)
		}
	}()

	zipWriter := zip.NewWriter(out)
	for _, file := range files {
		if err := addFile(zipWriter, file); err != nil {
			_ = zipWriter.Close()
			_ = out.Close()
			return err
		}
	}
	if err := zipWriter.Close(); err != nil {
		_ = out.Close()
		return fmt.Errorf("close archive: %w", err)
	}
	if err := out.Close(); err != nil {
		return fmt.Errorf("close archive file: %w", err)
	}
	success = true
	return nil
}

func collectFiles(root string, maxBytes int64) ([]archiveFile, error) {
	cleanRoot := filepath.Clean(root)
	var files []archiveFile
	var total int64
	err := filepath.WalkDir(cleanRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		if info.Size() > maxBytes-total {
			return fmt.Errorf("folder size exceeds %s limit", formatBytes(maxBytes))
		}
		total += info.Size()
		rel, err := filepath.Rel(cleanRoot, path)
		if err != nil {
			return err
		}
		files = append(files, archiveFile{
			path: path,
			rel:  filepath.ToSlash(rel),
			info: info,
		})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("walk %s: %w", root, err)
	}
	sort.Slice(files, func(i, j int) bool {
		return files[i].rel < files[j].rel
	})
	return files, nil
}

func addFile(zipWriter *zip.Writer, file archiveFile) error {
	header, err := zip.FileInfoHeader(file.info)
	if err != nil {
		return fmt.Errorf("create archive header for %s: %w", file.rel, err)
	}
	header.Name = file.rel
	header.Method = zip.Deflate

	writer, err := zipWriter.CreateHeader(header)
	if err != nil {
		return fmt.Errorf("create archive entry for %s: %w", file.rel, err)
	}

	in, err := os.Open(file.path)
	if err != nil {
		return fmt.Errorf("open %s: %w", file.rel, err)
	}
	_, copyErr := io.Copy(writer, in)
	closeErr := in.Close()
	if copyErr != nil {
		return fmt.Errorf("archive %s: %w", file.rel, copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close %s: %w", file.rel, closeErr)
	}
	return nil
}

func formatBytes(size int64) string {
	if size < 1024 {
		return fmt.Sprintf("%d B", size)
	}
	value := float64(size)
	units := []string{"B", "KB", "MB", "GB", "TB"}
	unit := 0
	for value >= 1024 && unit < len(units)-1 {
		value /= 1024
		unit++
	}
	if value < 10 {
		return fmt.Sprintf("%.1f %s", value, units[unit])
	}
	return fmt.Sprintf("%.0f %s", value, units[unit])
}
