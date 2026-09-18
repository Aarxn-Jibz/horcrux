//go:build windows

package identity

// Windows does not expose a portable directory fsync through os.File. The
// identity file is synced before its atomic rename, but power loss immediately
// after that rename can still lose the directory entry.
func syncDirectory(string) error { return nil }
