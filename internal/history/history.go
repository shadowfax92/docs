package history

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

type Entry struct {
	UploadedAt time.Time `json:"uploaded_at"`
	Name       string    `json:"name"`
	URL        string    `json:"url"`
	ID         string    `json:"id,omitempty"`
	Path       string    `json:"path,omitempty"`
}

type Filter struct {
	Limit int
	Since time.Time
}

type Store struct {
	path string
}

// DefaultPath returns the local upload-history file next to docs config.
func DefaultPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot determine home directory: %w", err)
	}
	return filepath.Join(home, ".config", "docs", "uploads.json"), nil
}

// NewDefaultStore creates a history store using the standard docs config directory.
func NewDefaultStore() (*Store, error) {
	path, err := DefaultPath()
	if err != nil {
		return nil, err
	}
	return NewStore(path), nil
}

// NewStore creates a history store backed by path.
func NewStore(path string) *Store {
	return &Store{path: path}
}

// Append persists a new upload entry while preserving existing history.
func (s *Store) Append(entry Entry) error {
	if entry.UploadedAt.IsZero() {
		entry.UploadedAt = time.Now().UTC()
	}
	entries, err := s.read()
	if err != nil {
		return err
	}
	entries = append(entries, entry)
	return s.write(entries)
}

// List returns upload history newest-first with optional age and count filters.
func (s *Store) List(filter Filter) ([]Entry, error) {
	entries, err := s.read()
	if err != nil {
		return nil, err
	}
	sort.SliceStable(entries, func(i, j int) bool {
		return entries[i].UploadedAt.After(entries[j].UploadedAt)
	})
	if !filter.Since.IsZero() {
		filtered := entries[:0]
		for _, entry := range entries {
			if entry.UploadedAt.Equal(filter.Since) || entry.UploadedAt.After(filter.Since) {
				filtered = append(filtered, entry)
			}
		}
		entries = filtered
	}
	if filter.Limit > 0 && len(entries) > filter.Limit {
		entries = entries[:filter.Limit]
	}
	return entries, nil
}

func (s *Store) read() ([]Entry, error) {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read upload history: %w", err)
	}
	if len(data) == 0 {
		return nil, nil
	}
	var entries []Entry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("parse upload history: %w", err)
	}
	return entries, nil
}

func (s *Store) write(entries []Entry) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return fmt.Errorf("create upload history directory: %w", err)
	}
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return fmt.Errorf("encode upload history: %w", err)
	}
	data = append(data, '\n')
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write upload history: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("replace upload history: %w", err)
	}
	return nil
}
