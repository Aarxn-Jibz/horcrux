package webrtc

import "testing"

func TestManagerStartsEmpty(t *testing.T) {
	manager := NewManager(nil)
	if manager.HasPeer("missing") {
		t.Fatal("missing peer reported as present")
	}
	if len(manager.peers) != 0 {
		t.Fatal("unexpected peers")
	}
	manager.CloseAll()
}

func TestManagerClosesExpiredSessions(t *testing.T) {
	manager := NewManager(nil)
	manager.peers["expired"] = nil
	manager.peers["active"] = nil
	manager.CloseExcept([]string{"active"})
	if _, ok := manager.peers["expired"]; ok {
		t.Fatal("expired peer remained registered")
	}
	if _, ok := manager.peers["active"]; !ok {
		t.Fatal("active peer was removed")
	}
}
