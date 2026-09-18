package main

import "testing"

func TestConfigDirectoryWithoutStartUsesDefaultCommand(t *testing.T) {
	args := []string{"--config-dir", `C:\Users\Teammate\AppData\Roaming\Horcrux`}
	command, commandArgs := splitCommand(args)
	if command != "start" {
		t.Fatalf("command = %q, want start", command)
	}
	if len(commandArgs) != len(args) || commandArgs[0] != args[0] || commandArgs[1] != args[1] {
		t.Fatalf("arguments changed: %#v", commandArgs)
	}
}
