package cmd

import (
	_ "embed"
	"fmt"

	"github.com/spf13/cobra"
)

//go:embed skill.md
var skillGuide string

var showSkill bool

var rootCmd = &cobra.Command{
	Use:          "docs",
	Short:        "Share files with short URLs",
	Long:         "Upload files and folders to get a short, shareable URL. Use 'docs upload --overwrite <file>' or 'docs update <id-or-url> [file]' to replace content at the same URL. Renderable documents open in the browser; other files get a download page.",
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		if showSkill {
			_, err := fmt.Fprint(cmd.OutOrStdout(), skillGuide)
			return err
		}
		return cmd.Help()
	},
}

func init() {
	rootCmd.Flags().BoolVar(&showSkill, "skill", false, "print a SKILL.md that teaches agents to use docs")
}

func Execute() error {
	return rootCmd.Execute()
}
