package storage

import (
	"os"
	"sync"
)

type lockedFile struct {
	*os.File
	release func()
	once    sync.Once
}

func (f *lockedFile) Close() error {
	err := f.File.Close()
	f.once.Do(f.release)
	return err
}
