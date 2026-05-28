package cmd

import (
	"fmt"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	"github.com/shadowfax/docs/internal/history"
)

var listDays int

var listCmd = &cobra.Command{
	Use:   "list",
	Short: "List recent uploads",
	Args:  cobra.NoArgs,
	RunE:  runList,
}

func init() {
	listCmd.Flags().IntVar(&listDays, "days", 0, "show uploads from the last N days")
	rootCmd.AddCommand(listCmd)
}

func runList(cmd *cobra.Command, args []string) error {
	if listDays < 0 {
		return fmt.Errorf("--days must be zero or greater")
	}
	store, err := history.NewDefaultStore()
	if err != nil {
		return err
	}

	now := time.Now()
	filter := history.Filter{Limit: 10}
	if listDays > 0 {
		filter = history.Filter{Since: now.AddDate(0, 0, -listDays)}
	}
	entries, err := store.List(filter)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "No uploads found")
		return nil
	}

	w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "AGE\tNAME\tURL")
	for _, entry := range entries {
		fmt.Fprintf(w, "%s\t%s\t%s\n", formatAge(now, entry.UploadedAt), entry.Name, entry.URL)
	}
	return w.Flush()
}

func formatAge(now time.Time, then time.Time) string {
	if then.IsZero() {
		return "unknown"
	}
	d := now.Sub(then)
	if d < 0 {
		d = 0
	}
	switch {
	case d < time.Minute:
		return "now"
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	case d < 30*24*time.Hour:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	default:
		return then.Format("2006-01-02")
	}
}
