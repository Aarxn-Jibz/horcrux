package webrtc

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// Manager owns only short-lived peers created from an authenticated signaling session.
type Manager struct {
	mu     sync.Mutex
	peers  map[string]*webrtc.PeerConnection
	config webrtc.Configuration
	api    *webrtc.API
}

func NewManager(servers []webrtc.ICEServer) *Manager {
	engine := webrtc.SettingEngine{}
	// Loopback candidates are intentionally enabled for direct local/LAN
	// development. Production NAT traversal still relies on configured ICE.
	engine.SetIncludeLoopbackCandidate(true)
	return &Manager{peers: map[string]*webrtc.PeerConnection{}, config: webrtc.Configuration{ICEServers: servers}, api: webrtc.NewAPI(webrtc.WithSettingEngine(engine))}
}

func (m *Manager) AcceptOffer(ctx context.Context, sessionID, encoded string, onChannel func(*webrtc.DataChannel)) (string, error) {
	debug := os.Getenv("HORCRUX_WEBRTC_DEBUG") == "1"
	m.mu.Lock()
	if _, exists := m.peers[sessionID]; exists {
		m.mu.Unlock()
		return "", fmt.Errorf("session already has a peer")
	}
	m.mu.Unlock()
	connection, err := m.api.NewPeerConnection(m.config)
	if err != nil {
		return "", err
	}
	connection.OnDataChannel(func(channel *webrtc.DataChannel) {
		if debug {
			slog.Info("webrtc data channel", "session", sessionID, "label", channel.Label())
			channel.OnOpen(func() { slog.Info("webrtc data channel open", "session", sessionID, "label", channel.Label()) })
		}
		if channel.Label() == "horcrux" {
			onChannel(channel)
		}
	})
	if debug {
		connection.OnICEGatheringStateChange(func(state webrtc.ICEGathererState) {
			slog.Info("webrtc ICE gathering", "session", sessionID, "state", state.String())
		})
		connection.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
			slog.Info("webrtc ICE connection", "session", sessionID, "state", state.String())
		})
	}
	connection.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if debug {
			slog.Info("webrtc peer connection", "session", sessionID, "state", state.String())
		}
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			m.Close(sessionID)
		}
	})
	if debug {
		connection.OnICECandidate(func(candidate *webrtc.ICECandidate) {
			if candidate == nil {
				slog.Info("webrtc local ICE candidates complete", "session", sessionID)
				return
			}
			slog.Info("webrtc local ICE candidate", "session", sessionID, "candidate", candidate.String())
		})
		connection.SCTP().Transport().ICETransport().OnSelectedCandidatePairChange(func(pair *webrtc.ICECandidatePair) {
			slog.Info("webrtc selected ICE candidate pair", "session", sessionID, "local", pair.Local.String(), "remote", pair.Remote.String())
		})
	}
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
