//go:build windows

package storage

// Windows does not expose a portable directory fsync through os.File. Object
// bytes are synced before their atomic rename; a sudden power loss immediately
// after that rename can still lose the directory entry.
func syncDirectory(string) error { return nil }
