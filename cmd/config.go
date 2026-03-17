package cmd

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/fatih/color"
	"github.com/spf13/cobra"

	"github.com/shadowfax/docs/internal/config"
)

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Configure worker URL and auth token",
	RunE:  runConfig,
}

func init() {
	rootCmd.AddCommand(configCmd)
}

func runConfig(cmd *cobra.Command, args []string) error {
	reader := bufio.NewReader(os.Stdin)

	fmt.Print("Worker URL (e.g. https://docs.yourdomain.com): ")
	url, _ := reader.ReadString('\n')
	url = strings.TrimSpace(url)

	fmt.Print("Auth token: ")
	token, _ := reader.ReadString('\n')
	token = strings.TrimSpace(token)

	if url == "" || token == "" {
		return fmt.Errorf("both URL and token are required")
	}

	cfg := &config.Config{
		URL:   url,
		Token: token,
	}
	if err := cfg.Save(); err != nil {
		return fmt.Errorf("failed to save config: %w", err)
	}

	color.New(color.FgGreen).Println("Config saved")
	return nil
}
