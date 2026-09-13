package webrtc

import "testing"

func TestManagerStartsEmpty(t *testing.T) {
	manager := NewManager(nil)
	if len(manager.peers) != 0 {
		t.Fatal("unexpected peers")
	}
	manager.CloseAll()
}
