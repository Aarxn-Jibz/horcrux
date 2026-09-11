package config

import (
	"errors"
	"flag"
)

const DefaultMaxConcurrent = 6

type Config struct {
	ListenAddress string
	DataDirectory string
	CapacityBytes int64
	MaxConcurrent int
}

func Parse(args []string) (Config, error) {
	set := flag.NewFlagSet("horcrux-node", flag.ContinueOnError)
	config := Config{}
	set.StringVar(&config.ListenAddress, "listen", "127.0.0.1:9443", "HTTPS listen address")
	set.StringVar(&config.DataDirectory, "data-dir", "./data", "directory owned by this node")
	set.Int64Var(&config.CapacityBytes, "capacity-bytes", 100*1024*1024*1024, "maximum object bytes managed by this node")
	set.IntVar(&config.MaxConcurrent, "max-concurrent", DefaultMaxConcurrent, "maximum concurrent object operations")
	if err := set.Parse(args); err != nil {
		return Config{}, err
	}
	if config.DataDirectory == "" {
		return Config{}, errors.New("data directory is required")
	}
	if config.CapacityBytes < 1 {
		return Config{}, errors.New("capacity must be positive")
	}
	if config.MaxConcurrent < 1 || config.MaxConcurrent > 64 {
		return Config{}, errors.New("max concurrency must be between 1 and 64")
	}
	return config, nil
}
