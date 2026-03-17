package config

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

type Config struct {
	URL   string `yaml:"url"`
	Token string `yaml:"token"`
}

func configDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot determine home directory: %w", err)
	}
	return filepath.Join(home, ".config", "docs"), nil
}

func Load() (*Config, error) {
	dir, err := configDir()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(dir, "config.yaml"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("config not found — run 'docs config' to set up")
		}
		return nil, err
	}
	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("invalid config: %w", err)
	}
	if cfg.URL == "" || cfg.Token == "" {
		return nil, fmt.Errorf("config incomplete — run 'docs config' to set url and token")
	}
	return &cfg, nil
}

func (c *Config) Save() error {
	dir, err := configDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	data, err := yaml.Marshal(c)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "config.yaml"), data, 0600)
}
