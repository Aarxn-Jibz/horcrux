package webrtc

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// Manager owns only short-lived peers created from an authenticated signaling session.
type Manager struct {
	mu     sync.Mutex
	peers  map[string]*webrtc.PeerConnection
	config webrtc.Configuration
}

func NewManager(servers []webrtc.ICEServer) *Manager {
	return &Manager{peers: map[string]*webrtc.PeerConnection{}, config: webrtc.Configuration{ICEServers: servers}}
}

func (m *Manager) AcceptOffer(ctx context.Context, sessionID, encoded string, onChannel func(*webrtc.DataChannel)) (string, error) {
	m.mu.Lock()
	if _, exists := m.peers[sessionID]; exists {
		m.mu.Unlock()
		return "", fmt.Errorf("session already has a peer")
	}
	m.mu.Unlock()
	connection, err := webrtc.NewPeerConnection(m.config)
	if err != nil {
		return "", err
	}
	connection.OnDataChannel(func(channel *webrtc.DataChannel) {
		if channel.Label() == "horcrux" {
			onChannel(channel)
		}
	})
	connection.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			m.Close(sessionID)
		}
	})
	if err := connection.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: encoded}); err != nil {
		connection.Close()
		return "", err
	}
	answer, err := connection.CreateAnswer(nil)
	if err != nil {
		connection.Close()
		return "", err
	}
	gathering := webrtc.GatheringCompletePromise(connection)
	if err := connection.SetLocalDescription(answer); err != nil {
		connection.Close()
		return "", err
	}
	select {
	case <-gathering:
	case <-ctx.Done():
		connection.Close()
		return "", ctx.Err()
	case <-time.After(15 * time.Second):
		connection.Close()
		return "", fmt.Errorf("ICE gathering timed out")
	}
	m.mu.Lock()
	m.peers[sessionID] = connection
	m.mu.Unlock()
	go func() { <-ctx.Done(); m.Close(sessionID) }()
	return connection.LocalDescription().SDP, nil
}
func (m *Manager) Close(sessionID string) {
	m.mu.Lock()
	peer := m.peers[sessionID]
	delete(m.peers, sessionID)
	m.mu.Unlock()
	if peer != nil {
		_ = peer.Close()
	}
}
func (m *Manager) CloseAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.peers))
	for id := range m.peers {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.Close(id)
	}
}
