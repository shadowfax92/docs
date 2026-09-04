package cmd

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/shadowfax/docs/internal/config"
	"github.com/shadowfax/docs/internal/history"
	"github.com/shadowfax/docs/internal/upload"
)

// deleteCmd coordinates authenticated remote deletion with local history reconciliation.
var deleteCmd = &cobra.Command{
	Use:   "delete <id>",
	Short: "Delete an upload by ID",
	Args:  cobra.ExactArgs(1),
	RunE:  runDelete,
}

func init() {
	rootCmd.AddCommand(deleteCmd)
}

func runDelete(cmd *cobra.Command, args []string) error {
	id := args[0]
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	// Remote absence must be definitive before local history changes. Otherwise an auth,
	// network, or storage failure could leave public content live after its local record vanished.
	deleted, err := upload.Delete(cfg, id)
	if err != nil {
		return err
	}

	store, err := history.NewDefaultStore()
	if err != nil {
		return deleteHistoryError(id, deleted, err)
	}
	removed, err := store.RemoveByID(id)
	if err != nil {
		return deleteHistoryError(id, deleted, err)
	}

	if deleted {
		fmt.Fprintln(cmd.OutOrStdout(), deletedMessage(id, removed))
		return nil
	}
	fmt.Fprintln(cmd.OutOrStdout(), missingMessage(id, removed))
	return nil
}

func deleteHistoryError(id string, deleted bool, err error) error {
	if deleted {
		return fmt.Errorf("deleted remote upload %s, but could not update local history: %w", id, err)
	}
	return fmt.Errorf("upload %s was not found remotely, but could not update local history: %w", id, err)
}

func deletedMessage(id string, removed int) string {
	switch removed {
	case 0:
		return fmt.Sprintf("Deleted upload %s; no matching local history entry", id)
	case 1:
		return fmt.Sprintf("Deleted upload %s and removed 1 local history entry", id)
	default:
		return fmt.Sprintf("Deleted upload %s and removed %d local history entries", id, removed)
	}
}

func missingMessage(id string, removed int) string {
	switch removed {
	case 0:
		return fmt.Sprintf("Upload %s was not found remotely; no matching local history entry", id)
	case 1:
		return fmt.Sprintf("Upload %s was not found remotely; removed 1 stale local history entry", id)
	default:
		return fmt.Sprintf("Upload %s was not found remotely; removed %d stale local history entries", id, removed)
	}
}
